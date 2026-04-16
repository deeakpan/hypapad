// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BondingCurveV2
 * @notice Virtual-reserve constant-product bonding curve.
 *
 * Two-phase init (factory pattern):
 *   1. Deploy with treasury + factory + graduationTarget
 *   2. Factory calls setToken() + setDevVesting() + setDexRouter() before first trade
 *
 * Fees:
 *   1% on every buy/sell → 0.8% to protocol treasury (immediate) +
 *   0.2% to token creator (accrued in-contract; creator calls claimCreatorFees())
 *   2% of raised ETH at graduation → treasury
 *
 * Buys: if the AMM would output more tokens than `token.balanceOf(this)`, the curve
 * only consumes enough gross ETH to reach that inventory cap and refunds the rest
 * (so `curve empty` is not hit for oversized `msg.value`).
 *
 * Graduation triggers when realEthReserve >= GRADUATION_ETH_TARGET:
 *   - 2% ETH → treasury
 *   - 98% ETH + 200M LP tokens → DEX via factory.seedLiquidity()
 *   - devVesting.startVesting() called
 */
contract BondingCurveV2 is ReentrancyGuard {

    uint256 public constant FEE_BPS              = 100;  // 1% total on buy/sell
    uint256 public constant TREASURY_TRADE_FEE_BPS = 80;  // 0.8% → protocol treasury
    uint256 public constant CREATOR_TRADE_FEE_BPS  = 20;  // 0.2% → token creator
    uint256 public constant GRAD_FEE_BPS  = 200;
    uint256 public constant BPS_DENOM     = 10_000;

    uint256 public constant VIRT_TOKEN_INIT = 1_073_000_191e18;
    uint256 public immutable VIRT_ETH_INIT;

    // ── immutables ────────────────────────────────────────────────────────────
    address public immutable protocolTreasury;
    address public immutable factory;
    address public immutable creator; // launch dev — receives trade fee share
    uint256 public immutable GRADUATION_ETH_TARGET;

    // ── set-once by factory ───────────────────────────────────────────────────
    IERC20  public token;
    address public devVesting;
    address public dexRouter;
    bool    private _tokenSet;
    bool    private _vestingSet;

    // ── state ─────────────────────────────────────────────────────────────────
    uint256 public virtualTokenReserve;
    uint256 public virtualEthReserve;
    uint256 public realEthReserve;
    bool    public graduated;
    /// @notice Creator's 0.2% trade fees (pull to save gas on every buy/sell).
    uint256 public pendingCreatorFees;

    // ── events ────────────────────────────────────────────────────────────────
    event Buy      (address indexed buyer,  uint256 ethIn,    uint256 tokensOut, uint256 fee);
    event Sell     (address indexed seller, uint256 tokensIn, uint256 ethOut,    uint256 fee);
    event Graduated(uint256 ethToLp, uint256 ethToTreasury, uint256 tokensToLp);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);

    constructor(
        address protocolTreasury_,
        address factory_,
        uint256 graduationEthTarget_,
        address creator_,
        uint256 virtEthInit_
    ) {
        require(protocolTreasury_ != address(0), "zero treasury");
        require(factory_          != address(0), "zero factory");
        require(graduationEthTarget_ > 0,        "zero target");
        require(creator_          != address(0), "zero creator");
        require(virtEthInit_ > 0,                "zero virt eth");

        protocolTreasury      = protocolTreasury_;
        factory               = factory_;
        creator               = creator_;
        GRADUATION_ETH_TARGET = graduationEthTarget_;
        VIRT_ETH_INIT         = virtEthInit_;

        virtualTokenReserve = VIRT_TOKEN_INIT;
        virtualEthReserve   = virtEthInit_;
    }

    // ── set-once setters (factory only) ───────────────────────────────────────
    function setToken(address token_) external {
        require(msg.sender == factory, "only factory");
        require(!_tokenSet,            "already set");
        require(token_ != address(0),  "zero token");
        _tokenSet = true;
        token     = IERC20(token_);
    }

    function setDevVesting(address vesting_) external {
        require(msg.sender == factory, "only factory");
        require(!_vestingSet,          "already set");
        require(vesting_ != address(0),"zero vesting");
        _vestingSet = true;
        devVesting  = vesting_;
    }

    function setDexRouter(address router_) external {
        require(msg.sender == factory, "only factory");
        require(router_ != address(0), "zero router");
        dexRouter = router_;
    }

    // ── trading ───────────────────────────────────────────────────────────────

    /// @dev Tokens out for a given net-ETH-after-fee (same integer math as legacy buy path).
    function _tokensOutFromEthAfterFee(uint256 ethAfterFee) internal view returns (uint256) {
        uint256 R = virtualTokenReserve;
        uint256 E = virtualEthReserve;
        return R - (R * E) / (E + ethAfterFee);
    }

    /// @dev Tokens out for gross ETH sent (1% fee then AMM).
    function _tokensOutFromGross(uint256 grossEth) internal view returns (uint256) {
        uint256 fee = (grossEth * FEE_BPS) / BPS_DENOM;
        uint256 e = grossEth - fee;
        return _tokensOutFromEthAfterFee(e);
    }

    /// @dev Largest gross in `(0, grossMax]` whose token output is `<= tokenCap` (binary search).
    function _maxGrossForTokenCap(uint256 grossMax, uint256 tokenCap) internal view returns (uint256) {
        if (tokenCap == 0) return 0;
        if (_tokensOutFromGross(grossMax) <= tokenCap) return grossMax;
        uint256 lo = 0;
        uint256 hi = grossMax;
        while (lo + 1 < hi) {
            uint256 mid = lo + (hi - lo) / 2;
            if (_tokensOutFromGross(mid) <= tokenCap) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    function buy(uint256 minTokensOut) external payable nonReentrant {
        require(address(token) != address(0), "not initialized");
        require(!graduated,    "graduated");
        require(msg.value > 0, "zero eth");

        uint256 grossIn = msg.value;
        uint256 poolBal = token.balanceOf(address(this));
        require(poolBal > 0, "curve empty");

        uint256 rawOut = _tokensOutFromGross(grossIn);
        uint256 tokenCap = rawOut > poolBal ? poolBal : rawOut;
        require(tokenCap >= minTokensOut, "slippage");

        uint256 grossUsed = _maxGrossForTokenCap(grossIn, tokenCap);
        require(grossUsed > 0, "zero eth");

        uint256 feeTotal = (grossUsed * FEE_BPS) / BPS_DENOM;
        uint256 feeTreasury = (grossUsed * TREASURY_TRADE_FEE_BPS) / BPS_DENOM;
        uint256 feeCreator = feeTotal - feeTreasury;
        uint256 ethAfterFee = grossUsed - feeTotal;

        uint256 tokensOut = _tokensOutFromEthAfterFee(ethAfterFee);
        require(tokensOut >= minTokensOut, "slippage");
        require(tokensOut <= poolBal, "curve empty");

        virtualEthReserve   += ethAfterFee;
        virtualTokenReserve -= tokensOut;
        realEthReserve      += ethAfterFee;

        _sendEth(protocolTreasury, feeTreasury);
        pendingCreatorFees += feeCreator;
        token.transfer(msg.sender, tokensOut);

        uint256 refund = grossIn - grossUsed;
        if (refund > 0) {
            (bool okRefund,) = payable(msg.sender).call{value: refund}("");
            require(okRefund, "refund failed");
        }

        emit Buy(msg.sender, grossUsed, tokensOut, feeTotal);

        if (realEthReserve >= GRADUATION_ETH_TARGET) _graduate();
    }

    function sell(uint256 tokensIn, uint256 minEthOut) external nonReentrant {
        require(address(token) != address(0), "not initialized");
        require(!graduated,   "graduated");
        require(tokensIn > 0, "zero tokens");

        uint256 grossEth = virtualEthReserve
            - (virtualEthReserve * virtualTokenReserve)
            / (virtualTokenReserve + tokensIn);

        uint256 feeTotal = (grossEth * FEE_BPS) / BPS_DENOM;
        uint256 feeTreasury = (grossEth * TREASURY_TRADE_FEE_BPS) / BPS_DENOM;
        uint256 feeCreator = feeTotal - feeTreasury;
        uint256 ethAfterFee = grossEth - feeTotal;

        require(ethAfterFee >= minEthOut,   "slippage");
        require(realEthReserve >= grossEth, "insufficient eth");

        virtualTokenReserve += tokensIn;
        virtualEthReserve   -= grossEth;
        realEthReserve      -= grossEth;

        token.transferFrom(msg.sender, address(this), tokensIn);
        _sendEth(protocolTreasury, feeTreasury);
        pendingCreatorFees += feeCreator;
        _sendEth(msg.sender, ethAfterFee);

        emit Sell(msg.sender, tokensIn, ethAfterFee, feeTotal);
    }

    /// @notice Creator pulls accrued 0.2% trade fees (one transfer, cheaper than per-trade).
    function claimCreatorFees() external nonReentrant {
        require(msg.sender == creator, "only creator");
        uint256 amount = pendingCreatorFees;
        require(amount > 0, "nothing to claim");
        pendingCreatorFees = 0;
        _sendEth(creator, amount);
        emit CreatorFeesClaimed(creator, amount);
    }

    // ── graduation ────────────────────────────────────────────────────────────
    function _graduate() internal {
        graduated = true;

        uint256 gradFee  = (realEthReserve * GRAD_FEE_BPS) / BPS_DENOM;
        uint256 ethToLp  = realEthReserve - gradFee;
        uint256 lpTokens = token.balanceOf(factory);

        realEthReserve = 0;

        IDevVesting(devVesting).startVesting();
        _sendEth(protocolTreasury, gradFee);
        IFactory(factory).seedLiquidity{value: ethToLp}(address(token), lpTokens, ethToLp);

        // burn any unsold curve tokens to dead address
        uint256 dust = token.balanceOf(address(this));
        if (dust > 0) token.transfer(0x000000000000000000000000000000000000dEaD, dust);

        emit Graduated(ethToLp, gradFee, lpTokens);
    }

    // ── views ─────────────────────────────────────────────────────────────────
    function quoteBuy(uint256 ethIn) external view returns (uint256 tokensOut, uint256 fee) {
        uint256 poolBal = token.balanceOf(address(this));
        if (poolBal == 0) return (0, 0);
        uint256 rawOut = _tokensOutFromGross(ethIn);
        uint256 tokenCap = rawOut > poolBal ? poolBal : rawOut;
        uint256 grossUsed = _maxGrossForTokenCap(ethIn, tokenCap);
        if (grossUsed == 0) return (0, 0);
        fee = (grossUsed * FEE_BPS) / BPS_DENOM;
        uint256 e = grossUsed - fee;
        tokensOut = _tokensOutFromEthAfterFee(e);
    }

    function quoteSell(uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee) {
        uint256 gross = virtualEthReserve
            - (virtualEthReserve * virtualTokenReserve)
            / (virtualTokenReserve + tokensIn);
        fee    = (gross * FEE_BPS) / BPS_DENOM;
        ethOut = gross - fee;
    }

    function currentPrice() external view returns (uint256) {
        return (virtualEthReserve * 1e18) / virtualTokenReserve;
    }

    function graduationProgress() external view returns (uint256) {
        if (graduated) return 1e18;
        return (realEthReserve * 1e18) / GRADUATION_ETH_TARGET;
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "eth send failed");
    }

    receive() external payable {}
}

interface IDevVesting { function startVesting() external; }
interface IFactory    { function seedLiquidity(address token, uint256 tokenAmount, uint256 ethAmount) external payable; }
