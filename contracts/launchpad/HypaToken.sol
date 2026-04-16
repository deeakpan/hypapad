// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title HypaToken
 * @notice ERC20 launched by TokenFactory. 1B total supply.
 *
 * Supply split (configurable):
 *   75%          → BondingCurve (sold on curve)
 *   devPct (1-5%)→ DevVesting   (linear vest)
 *   remainder    → Factory      (DEX LP at graduation, 20-24%)
 *
 * Metadata:
 *   tokenURI() returns "ipfs://{ipfsHash}"
 *   JSON must contain { name, symbol, description, image } fields
 *   "image" field is read by MetaMask, Trust Wallet etc.
 */
contract HypaToken is ERC20 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_PCT    = 75;
    uint256 public constant MAX_DEV_PCT  = 5;
    uint256 public constant MIN_DEV_PCT  = 1;

    uint256 public immutable devPct;
    uint256 public immutable lpPct;

    string private _tokenURI;

    event TokenURIUpdated(string uri);

    constructor(
        string memory name_,
        string memory symbol_,
        address bondingCurve_,
        address devVesting_,
        address factory_,
        uint256 devAllocationPct_,
        string memory ipfsHash_       // e.g. "QmXyz..." without ipfs:// prefix
    ) ERC20(name_, symbol_) {
        require(bondingCurve_     != address(0), "zero curve");
        require(devVesting_       != address(0), "zero vesting");
        require(factory_          != address(0), "zero factory");
        require(
            devAllocationPct_ >= MIN_DEV_PCT &&
            devAllocationPct_ <= MAX_DEV_PCT,
            "dev alloc out of range"
        );

        devPct = devAllocationPct_;
        lpPct  = 100 - CURVE_PCT - devAllocationPct_;

        uint256 curveSupply = (TOTAL_SUPPLY * CURVE_PCT)           / 100;
        uint256 devSupply   = (TOTAL_SUPPLY * devAllocationPct_)   / 100;
        uint256 lpSupply    = TOTAL_SUPPLY - curveSupply - devSupply;

        _mint(bondingCurve_, curveSupply);
        _mint(devVesting_,   devSupply);
        _mint(factory_,      lpSupply);

        if (bytes(ipfsHash_).length > 0) {
            _tokenURI = string(abi.encodePacked("ipfs://", ipfsHash_));
        }
    }

    /// @notice Returns metadata URI — wallets fetch this and read "image" field
    function tokenURI() external view returns (string memory) {
        return _tokenURI;
    }
}
