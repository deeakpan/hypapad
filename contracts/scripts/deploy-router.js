import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import hre, { network } from "hardhat";

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

    console.log("\nDeploying router on:", networkName);
    console.log("Deployer:", deployer.address);
    console.log(
      "Balance:",
      ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
      "ETH\n",
    );

    // Read existing deployment to get factory + WETH addresses
    const contractsDeployPath = path.join(process.cwd(), "deployments.json");
    const existing = JSON.parse(await readFile(contractsDeployPath, "utf8"));

    const factoryAddr = existing.contracts.UniswapV2Factory;
    const wethAddr    = existing.contracts.WETH9;

    if (!factoryAddr || !wethAddr) {
      throw new Error("deployments.json is missing UniswapV2Factory or WETH9 addresses");
    }

    console.log("Using factory:", factoryAddr);
    console.log("Using WETH:   ", wethAddr, "\n");

    console.log("Deploying UniswapV2Router02...");
    const Router = await ethers.getContractFactory("UniswapV2Router02");
    const router = await Router.deploy(factoryAddr, wethAddr);
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();
    console.log("Router:", routerAddr, "\n");

    // Update contracts/deployments.json
    existing.contracts.UniswapV2Router02 = routerAddr;
    existing.deployedAt = new Date().toISOString();
    await writeFile(contractsDeployPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
    console.log("Updated", contractsDeployPath);

    // Update frontend/deployments.json
    const frontendDeployPath = path.join(process.cwd(), "..", "frontend", "deployments.json");
    const frontend = JSON.parse(await readFile(frontendDeployPath, "utf8"));
    frontend.contracts.UniswapV2Router02 = routerAddr;
    frontend.deployedAt = new Date().toISOString();
    await writeFile(frontendDeployPath, `${JSON.stringify(frontend, null, 2)}\n`, "utf8");
    console.log("Updated", frontendDeployPath);

    console.log("\nDone. New router:", routerAddr);
  } finally {
    await connection.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
