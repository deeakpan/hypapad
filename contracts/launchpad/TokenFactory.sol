// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./HypaToken.sol";
import "./BondingCurve.sol";
import "./DevVesting.sol";
import "../markets/PredictionMarket.sol";

/**
 * @title TokenFactory
 * @notice One-tx launch: HypaToken + BondingCurve + DevVesting + PredictionMarkets.
 *
 * Creator configures at launch:
 *   - devAllocationPct: 1–5%
 *   - vestingMonths: 1–6
 *   - ipfsHash: token image metadata
 *   - launchMarketBitmask: which on-curve markets to open (bits 0-3)
 *   - graduationMarketBitmask: which post-migration markets to open (bits 0-3)
 *   - market params: ethTarget, multipliers, deadlines etc.
 *
 * DEX router abstracted — swap address for mainnet native DEX.
 * Pool address captured at graduation and stored per token.
 *
 * Launch: caller must send exactly `launchFeeWei` (set at factory deploy) to
 * `protocolTreasury` — pays for listing / spam control.
 */
contract TokenFactory {

    // ── config ────────────────────────────────────────────────────────────────
    address public owner;
    address public protocolTreasury;
    address public dexRouter;
    address public predictionMarket;
    uint256 public graduationEthTarget = 18 ether;
    uint256 public virtualEthInit      = 8 ether;
    /// @notice Native ETH required on each `launch` (sent to protocol treasury).
    uint256 public immutable launchFeeWei;

    // ── registry ──────────────────────────────────────────────────────────────
    struct LaunchInfo {
        address token;
        address bondingCurve;
        address devVesting;
        address pool;           // Uniswap V2 pool — set at graduation
        address dev;
        uint256 launchedAt;
        bool    graduated;
        // Graduation market params stored for post-migration market creation
        uint8   gradMarketBitmask;
        uint256 gradMcapMultX10;
        uint256 gradMcapMultDays;
        uint256 gradPriceMultX10;
        uint256 gradPriceMultDays;
        uint256 gradMinLiquidity;
        uint256 gradLiquidityDays;
    }

    address[]                      public allTokens;
    mapping(address => LaunchInfo) public launches;
    mapping(address => address[])  public devTokens;

    // ── events ────────────────────────────────────────────────────────────────
    event Launched     (address indexed token, address indexed curve, address indexed dev, string name, string symbol);
    event Graduated    (address indexed token, address pool);
    event LiquiditySeeded(address indexed token, uint256 eth, uint256 tokens);
    event RouterUpdated(address router);

    constructor(address treasury_, address dexRouter_, uint256 launchFeeWei_) {
        require(treasury_ != address(0), "zero treasury");
        owner            = msg.sender;
        protocolTreasury = treasury_;
        dexRouter        = dexRouter_;
        launchFeeWei     = launchFeeWei_;
    }

    // ── launch params struct (avoids stack too deep) ──────────────────────────
    struct LaunchParams {
        string  name;
        string  symbol;
        string  ipfsHash;           // IPFS hash for token image metadata
        uint256 devAllocationPct;   // 1–5
        uint256 vestingMonths;      // 1–6
        // On-curve market selection
        uint8   launchMarketBitmask; // bits: 0=GRAD_24H 1=GRAD_72H 2=ETH_TARGET 3=PRICE_MULT
        uint256 ethTarget;           // ETH_TARGET market param (wei)
        uint256 ethTargetHours;      // ETH_TARGET deadline
        uint256 launchPriceMultX10;  // PRICE_MULT param (e.g. 20=2x)
        uint256 launchPriceMultHours;// PRICE_MULT deadline
        // Post-graduation market selection
        uint8   gradMarketBitmask;   // bits: 0=MCAP_MULT 1=MCAP_RANGE 2=PRICE_MULT 3=LIQUIDITY
        uint256 gradMcapMultX10;
        uint256 gradMcapMultDays;
        uint256 gradPriceMultX10;
        uint256 gradPriceMultDays;
        uint256 gradMinLiquidity;
        uint256 gradLiquidityDays;
    }

    // ── launch ────────────────────────────────────────────────────────────────
    function launch(LaunchParams calldata p)
        external
        payable
        returns (address token_, address curve_, address vesting_)
    {
        require(msg.value == launchFeeWei, "launch fee");

        // 1. Deploy BondingCurve (creator gets bonding trade fee share)
        BondingCurveV2 curve = new BondingCurveV2(
            protocolTreasury,
            address(this),
            graduationEthTarget,
            msg.sender,
            virtualEthInit
        );

        // 2. Deploy DevVesting
        DevVestingV2 vesting = new DevVestingV2(
            msg.sender,
            address(curve),
            p.vestingMonths
        );

        // 3. Wire vesting into curve
        curve.setDevVesting(address(vesting));

        // 4. Deploy HypaToken with ipfsHash metadata
        HypaToken token = new HypaToken(
            p.name,
            p.symbol,
            address(curve),
            address(vesting),
            address(this),
            p.devAllocationPct,
            p.ipfsHash
        );

        // 5. Set token on curve and vesting
        curve.setToken(address(token));
        vesting.setToken(address(token));

        // 6. Set dex router
        if (dexRouter != address(0)) curve.setDexRouter(dexRouter);

        // 7. Register
        launches[address(token)] = LaunchInfo({
            token:              address(token),
            bondingCurve:       address(curve),
            devVesting:         address(vesting),
            pool:               address(0),
            dev:                msg.sender,
            launchedAt:         block.timestamp,
            graduated:          false,
            gradMarketBitmask:  p.gradMarketBitmask,
            gradMcapMultX10:    p.gradMcapMultX10,
            gradMcapMultDays:   p.gradMcapMultDays,
            gradPriceMultX10:   p.gradPriceMultX10,
            gradPriceMultDays:  p.gradPriceMultDays,
            gradMinLiquidity:   p.gradMinLiquidity,
            gradLiquidityDays:  p.gradLiquidityDays
        });
        allTokens.push(address(token));
        devTokens[msg.sender].push(address(token));

        // 8. Create on-curve prediction markets
        if (predictionMarket != address(0) && p.launchMarketBitmask != 0) {
            PredictionMarket(payable(predictionMarket)).createLaunchMarkets(
                address(token),
                address(curve),
                p.launchMarketBitmask,
                p.ethTarget,
                p.ethTargetHours,
                p.launchPriceMultX10,
                p.launchPriceMultHours
            );
        }

        emit Launched(address(token), address(curve), msg.sender, p.name, p.symbol);

        (bool feeOk,) = payable(protocolTreasury).call{value: launchFeeWei}("");
        require(feeOk, "fee send failed");

        return (address(token), address(curve), address(vesting));
    }

    // ── graduation callback ───────────────────────────────────────────────────
    function seedLiquidity(address token_, uint256 tokenAmount, uint256 ethAmount)
        external payable
    {
        LaunchInfo storage info = launches[token_];
        require(msg.sender == info.bondingCurve, "only curve");
        require(!info.graduated,                 "already graduated");
        require(msg.value == ethAmount,          "eth mismatch");

        info.graduated = true;
        address pool   = address(0);

        if (dexRouter != address(0)) {
            IERC20(token_).approve(dexRouter, tokenAmount);
            // addLiquidityETH returns (amountToken, amountETH, liquidity)
            // Pool address derived from router's factory + token pair
            IUniswapV2Router(dexRouter).addLiquidityETH{value: ethAmount}(
                token_, tokenAmount, 0, 0,
                address(0),           // LP burned
                block.timestamp + 300
            );
            // Get pool address from Uniswap factory
            address uniFactory = IUniswapV2Router(dexRouter).factory();
            address weth       = IUniswapV2Router(dexRouter).WETH();
            pool = IUniswapV2Factory(uniFactory).getPair(token_, weth);
            info.pool = pool;
        }

        emit LiquiditySeeded(token_, ethAmount, tokenAmount);
        emit Graduated(token_, pool);

        // Resolve any open pre-grad markets (GRAD_24H / GRAD_72H) — must happen
        // before creating post-grad markets so staking on known outcomes is blocked.
        if (predictionMarket != address(0)) {
            PredictionMarket(payable(predictionMarket)).resolveGradMarkets(token_);
        }

        // Create post-graduation prediction markets
        if (predictionMarket != address(0) && pool != address(0) && info.gradMarketBitmask != 0) {
            uint256 gradPrice = IBondingCurveV2(info.bondingCurve).currentPrice();
            PredictionMarket(payable(predictionMarket)).createGraduationMarkets(
                token_,
                pool,
                graduationEthTarget,
                gradPrice,
                info.gradMarketBitmask,
                info.gradMcapMultX10,
                info.gradMcapMultDays,
                info.gradPriceMultX10,
                info.gradPriceMultDays,
                info.gradMinLiquidity,
                info.gradLiquidityDays
            );
        }
    }

    function seedLiquidityManual(address token_) external onlyOwner {
        LaunchInfo storage info = launches[token_];
        require(info.graduated,          "not graduated");
        require(dexRouter != address(0), "no router");
        uint256 tb = IERC20(token_).balanceOf(address(this));
        uint256 eb = address(this).balance;
        require(tb > 0 && eb > 0, "nothing to seed");
        IERC20(token_).approve(dexRouter, tb);
        IUniswapV2Router(dexRouter).addLiquidityETH{value: eb}(
            token_, tb, 0, 0, address(0), block.timestamp + 300
        );
    }

    // ── admin ─────────────────────────────────────────────────────────────────
    function setDexRouter(address r)        external onlyOwner { dexRouter = r; emit RouterUpdated(r); }
    function setPredictionMarket(address p) external onlyOwner { require(p != address(0)); predictionMarket = p; }
    function setGraduationTarget(uint256 t) external onlyOwner { require(t > 0); graduationEthTarget = t; }
    function setVirtualEthInit(uint256 v)   external onlyOwner { require(v > 0); virtualEthInit = v; }
    function setTreasury(address t)         external onlyOwner { require(t != address(0)); protocolTreasury = t; }
    function transferOwnership(address n)   external onlyOwner { require(n != address(0)); owner = n; }

    function totalLaunched() external view returns (uint256) { return allTokens.length; }
    function getDevTokens(address dev_) external view returns (address[] memory) { return devTokens[dev_]; }
    function getPool(address token_) external view returns (address) { return launches[token_].pool; }

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    receive() external payable {}
}

// ── interfaces ────────────────────────────────────────────────────────────────

interface IUniswapV2Router {
    function addLiquidityETH(
        address token, uint amountTokenDesired, uint amountTokenMin,
        uint amountETHMin, address to, uint deadline
    ) external payable returns (uint, uint, uint);
    function factory() external pure returns (address);
    function WETH()    external pure returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

interface IBondingCurveV2 {
    function currentPrice() external view returns (uint256);
}
