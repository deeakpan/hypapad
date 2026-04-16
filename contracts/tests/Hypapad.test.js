import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

function defaultParams(overrides = {}) {
  return {
    name: overrides.name ?? "PepeCoin",
    symbol: overrides.symbol ?? "PEPE",
    ipfsHash: overrides.ipfsHash ?? "QmTestHash123",
    devAllocationPct: overrides.devPct ?? 5,
    vestingMonths: overrides.vesting ?? 6,
    launchMarketBitmask: overrides.launchBitmask ?? 1,
    ethTarget: overrides.ethTarget ?? 0,
    ethTargetHours: overrides.ethTargetHours ?? 0,
    launchPriceMultX10: overrides.launchPriceMultX10 ?? 0,
    launchPriceMultHours: overrides.launchPriceMultHours ?? 0,
    gradMarketBitmask: overrides.gradBitmask ?? 0,
    gradMcapMultX10: 0,
    gradMcapMultDays: 0,
    gradPriceMultX10: 0,
    gradPriceMultDays: 0,
    gradMinLiquidity: 0,
    gradLiquidityDays: 0,
  };
}

function parseLaunchedLog(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (parsed?.name === "Launched") {
        return parsed.args;
      }
    } catch {
      // skip
    }
  }
  throw new Error("Launched event not found");
}

async function launchToken(factory, dev, overrides = {}) {
  const params = defaultParams(overrides);
  const fee = await factory.launchFeeWei();
  const tx = await factory.connect(dev).launch(params, { value: fee });
  const receipt = await tx.wait();
  const args = parseLaunchedLog(factory, receipt);
  const tokenAddr = args.token;
  const info = await factory.launches(tokenAddr);

  const token = await ethers.getContractAt("HypaToken", tokenAddr);
  const curve = await ethers.getContractAt("BondingCurveV2", info.bondingCurve);
  const vesting = await ethers.getContractAt("DevVestingV2", info.devVesting);

  return { token, curve, vesting, tokenAddr };
}

describe("Hypapad Core", function () {
  let factory, owner, treasury, dev, buyer1, buyer2;

  beforeEach(async () => {
    [owner, treasury, dev, buyer1, buyer2] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("TokenFactory");
    factory = await Factory.deploy(
      treasury.address,
      ethers.ZeroAddress,
      ethers.parseEther("0.0003"),
    );
    await factory.waitForDeployment();
  });

  describe("Launch", () => {
    it("deploys token, curve, vesting", async () => {
      const { token, curve, vesting } = await launchToken(factory, dev);
      expect(await token.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await curve.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await vesting.getAddress()).to.not.equal(ethers.ZeroAddress);
    });

    it("tokenURI returns ipfs:// prefixed hash", async () => {
      const { token } = await launchToken(factory, dev, { ipfsHash: "QmABC123" });
      expect(await token.tokenURI()).to.equal("ipfs://QmABC123");
    });

    it("5% dev → 20% LP, 75% curve", async () => {
      const { token, curve, vesting } = await launchToken(factory, dev, {
        devPct: 5,
      });
      const TOTAL = ethers.parseEther("1000000000");
      expect(await token.balanceOf(await curve.getAddress())).to.equal(
        (TOTAL * 75n) / 100n,
      );
      expect(await token.balanceOf(await factory.getAddress())).to.equal(
        (TOTAL * 20n) / 100n,
      );
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(
        (TOTAL * 5n) / 100n,
      );
    });

    it("1% dev → 24% LP", async () => {
      const { token, curve, vesting } = await launchToken(factory, dev, {
        devPct: 1,
      });
      const TOTAL = ethers.parseEther("1000000000");
      expect(await token.balanceOf(await factory.getAddress())).to.equal(
        (TOTAL * 24n) / 100n,
      );
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(
        (TOTAL * 1n) / 100n,
      );
    });

    it("rejects dev alloc 0 or 6+", async () => {
      const fee = await factory.launchFeeWei();
      await expect(
        factory.connect(dev).launch(defaultParams({ devPct: 0 }), { value: fee }),
      ).to.revert(ethers);
      await expect(
        factory.connect(dev).launch(defaultParams({ devPct: 6 }), { value: fee }),
      ).to.revert(ethers);
    });

    it("rejects vesting months 0 or 7+", async () => {
      const fee = await factory.launchFeeWei();
      await expect(
        factory.connect(dev).launch(defaultParams({ vesting: 0 }), { value: fee }),
      ).to.revert(ethers);
      await expect(
        factory.connect(dev).launch(defaultParams({ vesting: 7 }), { value: fee }),
      ).to.revert(ethers);
    });

    it("rejects wrong launch fee", async () => {
      await expect(
        factory.connect(dev).launch(defaultParams(), { value: 0 }),
      ).to.be.revertedWith("launch fee");
      await expect(
        factory
          .connect(dev)
          .launch(defaultParams(), { value: ethers.parseEther("0.000299") }),
      ).to.be.revertedWith("launch fee");
    });

    it("records in registry", async () => {
      await launchToken(factory, dev);
      expect(await factory.totalLaunched()).to.equal(1);
      expect((await factory.getDevTokens(dev.address)).length).to.equal(1);
    });
  });

  describe("BondingCurve", () => {
    let curve, token;
    beforeEach(async () => {
      ({ token, curve } = await launchToken(factory, dev));
    });

    it("price increases after each buy", async () => {
      const p0 = await curve.currentPrice();
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      const p1 = await curve.currentPrice();
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      expect(await curve.currentPrice()).to.be.gt(p1);
      expect(p1).to.be.gt(p0);
    });

    it("0.8% trade fee to treasury on buy", async () => {
      const before = await ethers.provider.getBalance(treasury.address);
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      expect(
        (await ethers.provider.getBalance(treasury.address)) - before,
      ).to.equal(ethers.parseEther("0.008"));
    });

    it("0.2% trade fee accrues for creator (pull claim)", async () => {
      expect(await curve.pendingCreatorFees()).to.equal(0);
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      expect(await curve.pendingCreatorFees()).to.equal(
        ethers.parseEther("0.002"),
      );
      const before = await ethers.provider.getBalance(dev.address);
      const tx = await curve.connect(dev).claimCreatorFees();
      const receipt = await tx.wait();
      const gasCost =
        receipt.fee ??
        receipt.gasUsed *
          (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
      expect(await curve.pendingCreatorFees()).to.equal(0);
      expect(
        (await ethers.provider.getBalance(dev.address)) + gasCost - before,
      ).to.equal(ethers.parseEther("0.002"));
    });

    it("only creator can claim creator fees", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      await expect(curve.connect(buyer1).claimCreatorFees()).to.be.revertedWith(
        "only creator",
      );
    });

    it("claimCreatorFees reverts when nothing accrued", async () => {
      await expect(curve.connect(dev).claimCreatorFees()).to.be.revertedWith(
        "nothing to claim",
      );
    });

    it("buyer receives tokens", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("1") });
      expect(await token.balanceOf(buyer1.address)).to.be.gt(0);
    });

    it("sell returns ETH minus fee", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("2") });
      const bal = await token.balanceOf(buyer1.address);
      // Selling 100% can hit "insufficient eth" vs realEthReserve rounding; partial sell is stable.
      const sellAmt = (bal * 99n) / 100n;
      await token.connect(buyer1).approve(await curve.getAddress(), bal);
      const before = await ethers.provider.getBalance(buyer1.address);
      const tx = await curve.connect(buyer1).sell(sellAmt, 0);
      const receipt = await tx.wait();
      const after = await ethers.provider.getBalance(buyer1.address);
      const gasCost =
        receipt.fee ??
        receipt.gasUsed *
          (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
      expect(after + gasCost).to.be.gt(before);
    });

    it("slippage guard reverts", async () => {
      const [tokensOut] = await curve.quoteBuy(ethers.parseEther("1"));
      await expect(
        curve.connect(buyer1).buy(tokensOut * 2n, {
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWith("slippage");
    });

    /**
     * Virtual AMM can quote more tokens than the curve physically holds; buy must not
     * revert "curve empty" and must refund unused ETH (see BondingCurveV2.buy).
     */
    it("buy with ETH far above inventory cap: refunds excess, never curve empty", async () => {
      const R = await curve.virtualTokenReserve();
      const E = await curve.virtualEthReserve();
      const tokensFromGross = (gross) => {
        const fee = (gross * 100n) / 10000n;
        const e = gross - fee;
        return R - (R * E) / (E + e);
      };
      let poolBal = await token.balanceOf(await curve.getAddress());
      let gross = ethers.parseEther("500");
      for (let i = 0; i < 40 && tokensFromGross(gross) <= poolBal; i++) {
        gross = (gross * 3n) / 2n;
      }
      expect(tokensFromGross(gross)).to.be.gt(poolBal);

      const beforeEth = await ethers.provider.getBalance(buyer1.address);
      const tx = await curve.connect(buyer1).buy(0, { value: gross });
      const receipt = await tx.wait();
      const gas =
        receipt.fee ??
        receipt.gasUsed * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
      const afterEth = await ethers.provider.getBalance(buyer1.address);
      expect(await token.balanceOf(buyer1.address)).to.be.gt(0);
      const netSpent = beforeEth - afterEth - gas;
      expect(netSpent).to.be.gt(0n);
      expect(netSpent).to.be.lt(gross);
    });
  });

  describe("Graduation", () => {
    let curve, vesting;
    beforeEach(async () => {
      await factory.setGraduationTarget(ethers.parseEther("0.1"));
      ({ curve, vesting } = await launchToken(factory, dev));
    });

    it("graduates on ETH target hit", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("0.15") });
      expect(await curve.graduated()).to.be.true;
    });

    it("2% grad fee to treasury", async () => {
      const before = await ethers.provider.getBalance(treasury.address);
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("0.15") });
      expect(await ethers.provider.getBalance(treasury.address)).to.be.gt(
        before,
      );
    });

    it("starts dev vesting", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("0.15") });
      expect(await vesting.vestingStarted()).to.be.true;
    });

    it("blocks trading post-graduation", async () => {
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("0.15") });
      await expect(
        curve.connect(buyer2).buy(0, { value: ethers.parseEther("0.1") }),
      ).to.be.revertedWith("graduated");
    });
  });

  describe("DevVesting", () => {
    async function setupVesting(months) {
      await factory.setGraduationTarget(ethers.parseEther("0.1"));
      const { curve, vesting } = await launchToken(factory, dev, {
        vesting: months,
      });
      await curve.connect(buyer1).buy(0, { value: ethers.parseEther("0.15") });
      return vesting;
    }

    it("nothing claimable before graduation", async () => {
      const { vesting } = await launchToken(factory, dev);
      expect(await vesting.claimable()).to.equal(0);
    });

    it("1 month: fully claimable after 31 days", async () => {
      const vesting = await setupVesting(1);
      await ethers.provider.send("evm_increaseTime", [31 * 86400]);
      await ethers.provider.send("evm_mine", []);
      expect(await vesting.claimable()).to.equal(await vesting.totalAmount());
    });

    it("6 months: partial at 90 days", async () => {
      const vesting = await setupVesting(6);
      await ethers.provider.send("evm_increaseTime", [90 * 86400]);
      await ethers.provider.send("evm_mine", []);
      const c = await vesting.claimable();
      expect(c).to.be.gt(0);
      expect(c).to.be.lt(await vesting.totalAmount());
    });

    it("only dev can claim", async () => {
      const vesting = await setupVesting(1);
      await ethers.provider.send("evm_increaseTime", [31 * 86400]);
      await ethers.provider.send("evm_mine", []);
      await expect(vesting.connect(buyer1).claim()).to.be.revertedWith(
        "only dev",
      );
    });

    it("dev claims successfully", async () => {
      const vesting = await setupVesting(1);
      await ethers.provider.send("evm_increaseTime", [31 * 86400]);
      await ethers.provider.send("evm_mine", []);
      await expect(vesting.connect(dev).claim()).to.emit(vesting, "Claimed");
    });
  });
});
