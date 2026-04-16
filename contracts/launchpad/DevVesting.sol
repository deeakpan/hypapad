// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DevVestingV2
 * @notice Holds dev allocation tokens for the token deployer.
 *         Cliff: graduation (BondingCurve calls startVesting).
 *         Vesting: linear over vestingDuration (1–6 months, set at deploy).
 *
 * Deploy order: factory deploys this → calls setToken() once → done.
 */
contract DevVestingV2 {
    uint256 public constant MIN_DURATION = 30 days;  // 1 month
    uint256 public constant MAX_DURATION = 180 days; // 6 months

    address public immutable dev;
    address public immutable bondingCurve;
    address public immutable factory;
    uint256 public immutable vestingDuration; // set at deploy, 30–180 days

    IERC20  public token;
    bool    private _tokenSet;

    uint256 public vestingStart;
    uint256 public totalAmount;
    uint256 public claimed;
    bool    public vestingStarted;

    event VestingStarted(uint256 startTime, uint256 total);
    event Claimed(address indexed dev, uint256 amount);

    constructor(address dev_, address bondingCurve_, uint256 vestingMonths_) {
        require(dev_          != address(0), "zero dev");
        require(bondingCurve_ != address(0), "zero curve");
        require(vestingMonths_ >= 1 && vestingMonths_ <= 6, "vesting: 1-6 months");

        dev             = dev_;
        bondingCurve    = bondingCurve_;
        factory         = msg.sender;
        vestingDuration = vestingMonths_ * 30 days;
    }

    /// @notice Called once by factory after HypaToken is deployed.
    function setToken(address token_) external {
        require(msg.sender == factory, "only factory");
        require(!_tokenSet,            "already set");
        require(token_ != address(0),  "zero token");
        _tokenSet = true;
        token     = IERC20(token_);
    }

    /// @notice Called by BondingCurve at graduation. Starts vesting clock.
    function startVesting() external {
        require(msg.sender == bondingCurve, "only curve");
        require(!vestingStarted,            "already started");
        vestingStarted = true;
        vestingStart   = block.timestamp;
        totalAmount    = token.balanceOf(address(this));
        emit VestingStarted(vestingStart, totalAmount);
    }

    /// @notice Dev claims linearly vested tokens.
    function claim() external {
        require(msg.sender == dev, "only dev");
        require(vestingStarted,    "not started");
        uint256 c = _vestedAmount() - claimed;
        require(c > 0, "nothing to claim");
        claimed += c;
        token.transfer(dev, c);
        emit Claimed(dev, c);
    }

    function claimable() external view returns (uint256) {
        if (!vestingStarted) return 0;
        return _vestedAmount() - claimed;
    }

    function _vestedAmount() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - vestingStart;
        if (elapsed >= vestingDuration) return totalAmount;
        return (totalAmount * elapsed) / vestingDuration;
    }
}
