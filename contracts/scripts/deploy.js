import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEther } from "ethers";
import hre, { network } from "hardhat";

/** Native ETH required per token launch (set on factory; sent to treasury each launch). */
const LAUNCH_FEE_WEI = parseEther("0.0003");

/** Brief pause between txs on live RPCs to avoid stale nonce / mempool races. */
async function pauseBetweenTxs(networkName) {
  if (networkName !== "default") {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Mainnet: 18 ETH target, 6.45 ETH virtual → ~11× price appreciation, ~624M tokens sold, ~126M burned at graduation
// Testnet: same VIRT_ETH ratio (6.45/18 = 0.358) scaled — 0.0024 ETH target → 0.00086 ETH virtual
// Graduation fires while tokens remain, ensuring it always triggers correctly.
const GRAD_TARGETS = {
  baseSepolia: "0.0024",
  baseMainnet: "18",
  pepeTestnet: "0.0024",
  pepeMainnet: "18",
  default: "0.0024",
  hardhat: "0.0024",
};

// VIRT_ETH must satisfy: VIRT_ETH × (750M / (1,073,000,191 − 750M)) > GRAD_TARGET
// i.e. VIRT_ETH × 2.3219 > GRAD_TARGET  →  VIRT_ETH > GRAD_TARGET / 2.3219
// mainnet: 18 / 2.3219 = 7.752  → use 8 ETH   (drain = 18.575 ETH > 18 ✓)
// testnet: 0.0024 / 2.3219 = 0.001033 → use 0.00107 (drain = 0.002484 ETH > 0.0024 ✓)
const VIRT_ETH_INITS = {
  baseSepolia: "0.00107",
  baseMainnet: "8",
  pepeTestnet: "0.00107",
  pepeMainnet: "8",
  default: "0.00107",
  hardhat: "0.00107",
};

async function main() {
  const selected =
    hre.globalOptions.network !== undefined
      ? hre.globalOptions.network
      : "default";

  const connection = await network.connect(
    selected === "default" ? undefined : { network: selected },
  );
  const { ethers } = connection;
  const networkName = connection.networkName;

  try {
    const [deployer] = await ethers.getSigners();

    console.log("\nDeploying Hypapad on:", networkName);
    console.log("Deployer:", deployer.address);
    console.log(
      "Balance: ",
      ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
      "ETH\n",
    );

    const gradEther = GRAD_TARGETS[networkName] ?? "0.002";
    const gradTarget = ethers.parseEther(gradEther);
    const virtEther = VIRT_ETH_INITS[networkName] ?? "0.00086";
    const virtEthInit = ethers.parseEther(virtEther);

    console.log("1. Deploying WETH9...");
    const WETH9 = await ethers.getContractFactory("WETH9");
    const weth = await WETH9.deploy();
    await weth.waitForDeployment();
    console.log("   WETH9:", await weth.getAddress());
    await pauseBetweenTxs(networkName);

    console.log("2. Deploying UniswapV2Factory...");
    const Factory = await ethers.getContractFactory("UniswapV2Factory");
    const uniFactory = await Factory.deploy(deployer.address);
    await uniFactory.waitForDeployment();
    console.log("   Factory:", await uniFactory.getAddress());
    await pauseBetweenTxs(networkName);

    console.log("3. Deploying UniswapV2Router02...");
    const Router = await ethers.getContractFactory("UniswapV2Router02");
    const router = await Router.deploy(
      await uniFactory.getAddress(),
      await weth.getAddress(),
    );
    await router.waitForDeployment();
    console.log("   Router:", await router.getAddress());
    await pauseBetweenTxs(networkName);

    console.log("4. Deploying TokenFactory...");
    const TokenFactory = await ethers.getContractFactory("TokenFactory");
    const tokenFactory = await TokenFactory.deploy(
      deployer.address,
      await router.getAddress(),
      LAUNCH_FEE_WEI,
    );
    await tokenFactory.waitForDeployment();
    console.log("   TokenFactory:", await tokenFactory.getAddress());
    await pauseBetweenTxs(networkName);

    console.log("5. Deploying PredictionMarket...");
    const PM = await ethers.getContractFactory("PredictionMarket");
    const pm = await PM.deploy(
      deployer.address,
      await tokenFactory.getAddress(),
    );
    await pm.waitForDeployment();
    console.log("   PredictionMarket:", await pm.getAddress());
    await pauseBetweenTxs(networkName);

    console.log("6. Wiring contracts...");
    await pauseBetweenTxs(networkName);
    await (await tokenFactory.setPredictionMarket(await pm.getAddress())).wait();
    await pauseBetweenTxs(networkName);
    await (await tokenFactory.setGraduationTarget(gradTarget)).wait();
    await pauseBetweenTxs(networkName);
    await (await tokenFactory.setVirtualEthInit(virtEthInit)).wait();
    console.log("   PredictionMarket wired into TokenFactory");
    console.log("   Graduation target:", ethers.formatEther(gradTarget), "ETH");
    console.log("   Virtual ETH init: ", ethers.formatEther(virtEthInit), "ETH");

    const { chainId } = await ethers.provider.getNetwork();
    const deploymentRecord = {
      network: networkName,
      chainId: Number(chainId),
      deployedAt: new Date().toISOString(),
      deployer: deployer.address,
      contracts: {
        WETH9: await weth.getAddress(),
        UniswapV2Factory: await uniFactory.getAddress(),
        UniswapV2Router02: await router.getAddress(),
        TokenFactory: await tokenFactory.getAddress(),
        PredictionMarket: await pm.getAddress(),
      },
      graduationTargetEth: gradEther,
      virtualEthInitEth: virtEther,
      launchFeeWei: LAUNCH_FEE_WEI.toString(),
      launchFeeEth: "0.0003",
    };
    const outPath = path.join(process.cwd(), "deployments.json");
    await writeFile(outPath, `${JSON.stringify(deploymentRecord, null, 2)}\n`, "utf8");
    console.log("Wrote", outPath);

    // Mirror to frontend/deployments.json — same pattern as deploy-router.js
    const frontendDeployPath = path.join(process.cwd(), "..", "frontend", "deployments.json");
    let frontendRecord;
    try {
      frontendRecord = JSON.parse(await readFile(frontendDeployPath, "utf8"));
      Object.assign(frontendRecord, deploymentRecord);
    } catch {
      frontendRecord = deploymentRecord;
    }
    await writeFile(frontendDeployPath, `${JSON.stringify(frontendRecord, null, 2)}\n`, "utf8");
    console.log("Wrote", frontendDeployPath);

    console.log("\nDeployment complete on", networkName);
    console.log("-".repeat(50));
    console.log("WETH:              ", await weth.getAddress());
    console.log("Uniswap Factory:   ", await uniFactory.getAddress());
    console.log("Uniswap Router:    ", await router.getAddress());
    console.log("TokenFactory:      ", await tokenFactory.getAddress());
    console.log("PredictionMarket:  ", await pm.getAddress());
    console.log("Graduation Target: ", ethers.formatEther(gradTarget), "ETH");
    console.log("Virtual ETH Init:  ", ethers.formatEther(virtEthInit), "ETH");
    console.log("Launch fee:        ", ethers.formatEther(LAUNCH_FEE_WEI), "ETH");
    console.log("-".repeat(50));
    console.log("\nSave these addresses for the frontend.\n");
  } finally {
    await connection.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
