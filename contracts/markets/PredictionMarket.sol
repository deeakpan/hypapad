// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PredictionMarket
 * @notice Parimutuel prediction markets for Hypapad.
 *
 * ON-CURVE market types (pre-migration, resolved via BondingCurve):
 *   GRAD_24H         — will token graduate within 24hrs?
 *   GRAD_72H         — will token graduate within 72hrs?
 *   ETH_TARGET       — will realEthReserve hit X ETH before deadline?
 *   PRICE_MULTIPLIER — will price reach N× creation price before deadline?
 *
 * POST-MIGRATION market types (after graduation, resolved via Uniswap V2):
 *   POST_MCAP_MULT   — will mcap reach N× graduation mcap before deadline?
 *   POST_MCAP_RANGE  — what mcap bucket at deadline? (below/1-3x/3-10x/10x+)
 *   POST_PRICE_MULT  — will price reach N× graduation price before deadline?
 *   POST_LIQUIDITY   — will pool still have >X ETH liquidity at deadline?
 *
 * CUSTOM — anything, resolved by factory owner.
 *
 * Resolution: all non-custom markets resolved trustlessly by anyone
 *   calling resolve() — contract reads chain state and settles.
 *
 * Fees: 2% entry fee on every stake → protocolTreasury (no exit).
 * Payout: winners split losing pool proportionally + get stake back.
 */
contract PredictionMarket is ReentrancyGuard {

    // ── enums ─────────────────────────────────────────────────────────────────
    enum MarketType {
        GRAD_24H,           // 0
        GRAD_72H,           // 1
        ETH_TARGET,         // 2
        PRICE_MULTIPLIER,   // 3
        POST_MCAP_MULT,     // 4
        POST_MCAP_RANGE,    // 5
        POST_PRICE_MULT,    // 6
        POST_LIQUIDITY,     // 7
        CUSTOM              // 8
    }

    enum MarketStatus { OPEN, RESOLVED, CANCELLED }

    // Range bucket for POST_MCAP_RANGE
    // Below graduation mcap / 1-3x / 3-10x / 10x+
    enum RangeBucket { BELOW, ONE_TO_THREE, THREE_TO_TEN, ABOVE_TEN }

    // ── structs ───────────────────────────────────────────────────────────────
    struct Market {
        address      token;
        address      curve;             // BondingCurve (on-curve markets)
        address      pool;              // Uniswap V2 pool (post-migration markets)
        MarketType   marketType;
        MarketStatus status;
        uint256      deadline;

        // Resolution params
        uint256      ethTarget;         // ETH_TARGET: target realEthReserve
        uint256      multiplierX10;     // PRICE/MCAP_MULT: target multiplier ×10 (e.g. 30 = 3x)
        uint256      strikePrice;       // snapshot price at market creation (on-curve)
        uint256      graduationMcap;    // graduation ETH threshold (post markets)
        uint256      graduationPrice;   // price per token at graduation (post markets)
        uint256      minLiquidity;      // POST_LIQUIDITY: minimum ETH in pool

        // TWAP snapshot (post-migration markets)
        uint256      cumulativeAtStart;
        uint256      timestampAtStart;

        // Range market
        RangeBucket  winningBucket;     // set on resolution

        string       description;
        bool         outcome;           // true=YES/higher bucket won
        uint256      resolutionTime;
    }

    // ── constants ─────────────────────────────────────────────────────────────
    uint256 public constant ENTRY_FEE_BPS = 200;   // 2%
    uint256 public constant BPS_DENOM     = 10_000;

    // ── state ─────────────────────────────────────────────────────────────────
    address public immutable protocolTreasury;
    address public immutable factory;

    uint256 public marketCount;

    mapping(uint256 => Market)                              public markets;
    mapping(uint256 => mapping(address => uint256))         public yesStakes;
    mapping(uint256 => mapping(address => uint256))         public noStakes;
    // Range market stakes: marketId → bucket → user → amount
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public rangeStakes;
    // Range market pool totals: marketId → bucket → total
    mapping(uint256 => mapping(uint8 => uint256))           public rangePool;

    mapping(uint256 => mapping(address => bool))            public claimed;
    mapping(address => uint256[])                           public tokenMarkets;

    // ── events ────────────────────────────────────────────────────────────────
    event MarketCreated  (uint256 indexed id, address indexed token, MarketType mtype, uint256 deadline);
    event StakePlaced      (uint256 indexed id, address indexed staker, uint8 side, uint256 net, uint256 fee);
    event MarketResolved (uint256 indexed id, bool outcome, uint8 bucket);
    event WinningsClaimed(uint256 indexed id, address indexed winner, uint256 amount);
    event MarketCancelled(uint256 indexed id);

    // ── constructor ───────────────────────────────────────────────────────────
    constructor(address treasury_, address factory_) {
        require(treasury_ != address(0), "zero treasury");
        require(factory_  != address(0), "zero factory");
        protocolTreasury = treasury_;
        factory          = factory_;
    }

    // ── market creation ───────────────────────────────────────────────────────

    /**
     * @notice Called by factory at token launch.
     *         Creator picks which on-curve markets to open (bitmask).
     *         Bit 0 = GRAD_24H, Bit 1 = GRAD_72H,
     *         Bit 2 = ETH_TARGET, Bit 3 = PRICE_MULTIPLIER
     *
     * @param token_          Token address
     * @param curve_          BondingCurve address
     * @param marketBitmask_  Which markets to create (0-15)
     * @param ethTarget_      Used if ETH_TARGET bit set (in wei)
     * @param ethTargetHours_ Deadline hours for ETH_TARGET
     * @param priceMultX10_   Used if PRICE_MULTIPLIER bit set (e.g. 20 = 2x)
     * @param priceMultHours_ Deadline hours for PRICE_MULTIPLIER
     */
    function createLaunchMarkets(
        address token_,
        address curve_,
        uint8   marketBitmask_,
        uint256 ethTarget_,
        uint256 ethTargetHours_,
        uint256 priceMultX10_,
        uint256 priceMultHours_
    ) external returns (uint256[] memory ids) {
        require(msg.sender == factory, "only factory");

        uint8 count = _popcount(marketBitmask_);
        ids = new uint256[](count);
        uint8 idx;

        if (marketBitmask_ & 1 != 0) {
            ids[idx++] = _createGradMarket(token_, curve_, MarketType.GRAD_24H, 24 hours);
        }
        if (marketBitmask_ & 2 != 0) {
            ids[idx++] = _createGradMarket(token_, curve_, MarketType.GRAD_72H, 72 hours);
        }
        if (marketBitmask_ & 4 != 0) {
            require(ethTarget_ > 0 && ethTargetHours_ > 0, "invalid eth target params");
            ids[idx++] = _createEthTargetMarket(token_, curve_, ethTarget_, ethTargetHours_ * 1 hours);
        }
        if (marketBitmask_ & 8 != 0) {
            require(priceMultX10_ >= 20 && priceMultHours_ > 0, "invalid price mult params");
            ids[idx++] = _createPriceMultMarket(token_, curve_, priceMultX10_, priceMultHours_ * 1 hours);
        }
    }

    /**
     * @notice Called by factory at graduation.
     *         Creator picks which post-migration markets to open (bitmask).
     *         Bit 0 = POST_MCAP_MULT(3x/7d), Bit 1 = POST_MCAP_RANGE(7d),
     *         Bit 2 = POST_PRICE_MULT(3x/7d), Bit 3 = POST_LIQUIDITY(30d)
     *
     * @param token_         Token address
     * @param pool_          Uniswap V2 pool address
     * @param gradMcap_      Graduation ETH threshold (from factory)
     * @param gradPrice_     Token price at graduation (from curve.currentPrice())
     * @param marketBitmask_ Which markets to create (0-15)
     * @param mcapMultX10_   Multiplier for POST_MCAP_MULT (e.g. 30 = 3x)
     * @param mcapMultDays_  Deadline days for POST_MCAP_MULT
     * @param priceMultX10_  Multiplier for POST_PRICE_MULT
     * @param priceMultDays_ Deadline days for POST_PRICE_MULT
     * @param minLiquidity_  Min ETH liquidity for POST_LIQUIDITY
     * @param liquidityDays_ Deadline days for POST_LIQUIDITY
     */
    function createGraduationMarkets(
        address token_,
        address pool_,
        uint256 gradMcap_,
        uint256 gradPrice_,
        uint8   marketBitmask_,
        uint256 mcapMultX10_,
        uint256 mcapMultDays_,
        uint256 priceMultX10_,
        uint256 priceMultDays_,
        uint256 minLiquidity_,
        uint256 liquidityDays_
    ) external returns (uint256[] memory ids) {
        require(msg.sender == factory, "only factory");

        uint8 count = _popcount(marketBitmask_);
        ids = new uint256[](count);
        uint8 idx;

        if (marketBitmask_ & 1 != 0) {
            require(mcapMultX10_ >= 20 && mcapMultDays_ > 0, "invalid mcap mult params");
            ids[idx++] = _createPostMcapMult(token_, pool_, gradMcap_, mcapMultX10_, mcapMultDays_ * 1 days);
        }
        if (marketBitmask_ & 2 != 0) {
            ids[idx++] = _createPostMcapRange(token_, pool_, gradMcap_, 7 days);
        }
        if (marketBitmask_ & 4 != 0) {
            require(priceMultX10_ >= 20 && priceMultDays_ > 0, "invalid price mult params");
            ids[idx++] = _createPostPriceMult(token_, pool_, gradPrice_, priceMultX10_, priceMultDays_ * 1 days);
        }
        if (marketBitmask_ & 8 != 0) {
            require(minLiquidity_ > 0 && liquidityDays_ > 0, "invalid liquidity params");
            ids[idx++] = _createPostLiquidity(token_, pool_, minLiquidity_, liquidityDays_ * 1 days);
        }
    }

    // Anyone can create custom on-curve markets
    function createEthTargetMarket(
        address token_, address curve_, uint256 ethTarget_, uint256 deadlineHours_
    ) external returns (uint256) {
        require(deadlineHours_ >= 1, "min 1 hour");
        return _createEthTargetMarket(token_, curve_, ethTarget_, deadlineHours_ * 1 hours);
    }

    function createPriceMultMarket(
        address token_, address curve_, uint256 multX10_, uint256 deadlineHours_
    ) external returns (uint256) {
        require(multX10_ >= 20 && deadlineHours_ >= 1, "invalid params");
        return _createPriceMultMarket(token_, curve_, multX10_, deadlineHours_ * 1 hours);
    }

    // Anyone can create custom post-migration markets
    function createPostMcapMultMarket(
        address token_, address pool_, uint256 gradMcap_, uint256 multX10_, uint256 deadlineDays_
    ) external returns (uint256) {
        require(multX10_ >= 20 && deadlineDays_ >= 1, "invalid params");
        return _createPostMcapMult(token_, pool_, gradMcap_, multX10_, deadlineDays_ * 1 days);
    }

    function createPostPriceMultMarket(
        address token_, address pool_, uint256 gradPrice_, uint256 multX10_, uint256 deadlineDays_
    ) external returns (uint256) {
        require(multX10_ >= 20 && deadlineDays_ >= 1, "invalid params");
        return _createPostPriceMult(token_, pool_, gradPrice_, multX10_, deadlineDays_ * 1 days);
    }

    function createPostLiquidityMarket(
        address token_, address pool_, uint256 minLiq_, uint256 deadlineDays_
    ) external returns (uint256) {
        require(minLiq_ > 0 && deadlineDays_ >= 1, "invalid params");
        return _createPostLiquidity(token_, pool_, minLiq_, deadlineDays_ * 1 days);
    }

    function createCustomMarket(
        address token_, string calldata description_, uint256 deadlineHours_
    ) external returns (uint256) {
        require(deadlineHours_ >= 1, "min 1 hour");
        require(bytes(description_).length > 0, "empty description");
        return _createMarketBase(token_, address(0), address(0), MarketType.CUSTOM,
            block.timestamp + deadlineHours_ * 1 hours, description_);
    }

    // ── internal market creators ──────────────────────────────────────────────

    function _createGradMarket(address t, address c, MarketType mt, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, c, address(0), mt, block.timestamp + duration, "");
    }

    function _createEthTargetMarket(address t, address c, uint256 target, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, c, address(0), MarketType.ETH_TARGET, block.timestamp + duration, "");
        markets[id].ethTarget = target;
    }

    function _createPriceMultMarket(address t, address c, uint256 multX10, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, c, address(0), MarketType.PRICE_MULTIPLIER, block.timestamp + duration, "");
        markets[id].multiplierX10 = multX10;
        markets[id].strikePrice   = IBondingCurve(c).currentPrice(); // snapshot now
    }

    function _createPostMcapMult(address t, address p, uint256 gradMcap, uint256 multX10, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, address(0), p, MarketType.POST_MCAP_MULT, block.timestamp + duration, "");
        markets[id].multiplierX10  = multX10;
        markets[id].graduationMcap = gradMcap;
        _snapshotTwap(id, p);
    }

    function _createPostMcapRange(address t, address p, uint256 gradMcap, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, address(0), p, MarketType.POST_MCAP_RANGE, block.timestamp + duration, "");
        markets[id].graduationMcap = gradMcap;
        _snapshotTwap(id, p);
    }

    function _createPostPriceMult(address t, address p, uint256 gradPrice, uint256 multX10, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, address(0), p, MarketType.POST_PRICE_MULT, block.timestamp + duration, "");
        markets[id].multiplierX10   = multX10;
        markets[id].graduationPrice = gradPrice;
        _snapshotTwap(id, p);
    }

    function _createPostLiquidity(address t, address p, uint256 minLiq, uint256 duration)
        internal returns (uint256 id)
    {
        id = _createMarketBase(t, address(0), p, MarketType.POST_LIQUIDITY, block.timestamp + duration, "");
        markets[id].minLiquidity = minLiq;
    }

    function _createMarketBase(
        address t, address c, address p, MarketType mt, uint256 deadline, string memory desc
    ) internal returns (uint256 id) {
        id = marketCount++;
        Market storage m = markets[id];
        m.token       = t;
        m.curve       = c;
        m.pool        = p;
        m.marketType  = mt;
        m.status      = MarketStatus.OPEN;
        m.deadline    = deadline;
        m.description = desc;
        tokenMarkets[t].push(id);
        emit MarketCreated(id, t, mt, deadline);
    }

    function _snapshotTwap(uint256 id, address pool) internal {
        markets[id].cumulativeAtStart = IUniswapV2Pair(pool).price0CumulativeLast();
        markets[id].timestampAtStart  = block.timestamp;
    }

    // ── staking ───────────────────────────────────────────────────────────────

    /**
     * @notice Stake on a binary (YES/NO) market.
     * @param side true=YES false=NO
     */
    function stake(uint256 marketId, bool side) external payable nonReentrant {
        Market storage m = markets[marketId];
        require(msg.value > 0,                       "zero stake");
        require(m.status == MarketStatus.OPEN,       "not open");
        require(block.timestamp < m.deadline,        "closed");
        require(m.marketType != MarketType.POST_MCAP_RANGE, "use stakeRange");

        uint256 fee = (msg.value * ENTRY_FEE_BPS) / BPS_DENOM;
        uint256 net = msg.value - fee;
        _sendEth(protocolTreasury, fee);

        if (side) { yesStakes[marketId][msg.sender] += net; m.outcome = true; }
        else       { noStakes[marketId][msg.sender]  += net; }

        // track pools
        if (side) _addToYesPool(marketId, net);
        else      _addToNoPool(marketId, net);

        emit StakePlaced(marketId, msg.sender, side ? 1 : 0, net, fee);
    }

    /**
     * @notice Stake on a range market bucket.
     * @param bucket 0=BELOW 1=ONE_TO_THREE 2=THREE_TO_TEN 3=ABOVE_TEN
     */
    function stakeRange(uint256 marketId, uint8 bucket) external payable nonReentrant {
        Market storage m = markets[marketId];
        require(msg.value > 0,                        "zero stake");
        require(m.status == MarketStatus.OPEN,        "not open");
        require(block.timestamp < m.deadline,         "closed");
        require(m.marketType == MarketType.POST_MCAP_RANGE, "not range market");
        require(bucket <= 3,                          "invalid bucket");

        uint256 fee = (msg.value * ENTRY_FEE_BPS) / BPS_DENOM;
        uint256 net = msg.value - fee;
        _sendEth(protocolTreasury, fee);

        rangeStakes[marketId][bucket][msg.sender] += net;
        rangePool[marketId][bucket]             += net;

        emit StakePlaced(marketId, msg.sender, bucket, net, fee);
    }

    // pool tracking helpers
    mapping(uint256 => uint256) public yesPool;
    mapping(uint256 => uint256) public noPool;
    function _addToYesPool(uint256 id, uint256 amt) internal { yesPool[id] += amt; }
    function _addToNoPool (uint256 id, uint256 amt) internal { noPool[id]  += amt; }

    // ── resolution ────────────────────────────────────────────────────────────

    /**
     * @notice Called by factory at graduation to immediately settle all open
     *         GRAD_24H and GRAD_72H markets for the token (outcome = YES).
     *         Prevents staking on markets whose outcome is already determined.
     */
    function resolveGradMarkets(address token_) external nonReentrant {
        require(msg.sender == factory, "only factory");
        uint256[] storage ids = tokenMarkets[token_];
        for (uint256 i = 0; i < ids.length; i++) {
            Market storage m = markets[ids[i]];
            if (m.status != MarketStatus.OPEN) continue;
            if (m.marketType != MarketType.GRAD_24H && m.marketType != MarketType.GRAD_72H) continue;
            _resolveYesNo(ids[i], true);
        }
    }

    /**
     * @notice Resolve any non-custom, non-range market. Anyone can call after deadline
     *         or when condition is already met.
     *         Contract reads chain state and settles trustlessly.
     */
    function resolve(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN, "not open");

        MarketType mt = m.marketType;

        // ── GRAD markets: curve resolves YES on graduation, anyone resolves NO after deadline
        if (mt == MarketType.GRAD_24H || mt == MarketType.GRAD_72H) {
            bool isGrad = IBondingCurve(m.curve).graduated();
            if (isGrad) {
                _resolveYesNo(marketId, true);
            } else {
                require(block.timestamp >= m.deadline, "not expired");
                _resolveYesNo(marketId, false);
            }
            return;
        }

        // ── ETH_TARGET: check realEthReserve
        if (mt == MarketType.ETH_TARGET) {
            uint256 raised = IBondingCurve(m.curve).realEthReserve();
            bool hit = raised >= m.ethTarget;
            if (!hit) require(block.timestamp >= m.deadline, "not expired");
            _resolveYesNo(marketId, hit);
            return;
        }

        // ── PRICE_MULTIPLIER: check currentPrice vs strikePrice * multiplier
        if (mt == MarketType.PRICE_MULTIPLIER) {
            uint256 current = IBondingCurve(m.curve).currentPrice();
            uint256 target  = (m.strikePrice * m.multiplierX10) / 10;
            bool hit = current >= target;
            if (!hit) require(block.timestamp >= m.deadline, "not expired");
            _resolveYesNo(marketId, hit);
            return;
        }

        // ── POST_MCAP_MULT: TWAP mcap vs graduation mcap * multiplier
        if (mt == MarketType.POST_MCAP_MULT) {
            require(block.timestamp >= m.deadline, "not expired");
            uint256 twapPrice = _getTwap(m.pool, m.cumulativeAtStart, m.timestampAtStart);
            uint256 twapMcap  = _computeMcap(m.pool, twapPrice);
            uint256 target    = (m.graduationMcap * m.multiplierX10) / 10;
            _resolveYesNo(marketId, twapMcap >= target);
            return;
        }

        // ── POST_PRICE_MULT: TWAP price vs graduation price * multiplier
        if (mt == MarketType.POST_PRICE_MULT) {
            require(block.timestamp >= m.deadline, "not expired");
            uint256 twapPrice = _getTwap(m.pool, m.cumulativeAtStart, m.timestampAtStart);
            uint256 target    = (m.graduationPrice * m.multiplierX10) / 10;
            _resolveYesNo(marketId, twapPrice >= target);
            return;
        }

        // ── POST_LIQUIDITY: spot getReserves (manipulation-resistant enough for liquidity check)
        if (mt == MarketType.POST_LIQUIDITY) {
            require(block.timestamp >= m.deadline, "not expired");
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(m.pool).getReserves();
            // ETH reserve — need to check which token is ETH (WETH)
            // We assume token0 is the launched token, token1 is WETH
            // Factory should set this correctly; for now use r1 as ETH reserve
            uint256 ethReserve = uint256(r1);
            _resolveYesNo(marketId, ethReserve >= m.minLiquidity);
            return;
        }

        // ── CUSTOM: only owner resolves
        revert("use resolveCustom");
    }

    /**
     * @notice Resolve a range market. Anyone calls after deadline.
     */
    function resolveRange(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN,              "not open");
        require(m.marketType == MarketType.POST_MCAP_RANGE, "not range");
        require(block.timestamp >= m.deadline,              "not expired");

        uint256 twapPrice = _getTwap(m.pool, m.cumulativeAtStart, m.timestampAtStart);
        uint256 currentMcap = _computeMcap(m.pool, twapPrice);
        uint256 gradMcap  = m.graduationMcap;

        RangeBucket bucket;
        if      (currentMcap < gradMcap)               bucket = RangeBucket.BELOW;
        else if (currentMcap < gradMcap * 3)           bucket = RangeBucket.ONE_TO_THREE;
        else if (currentMcap < gradMcap * 10)          bucket = RangeBucket.THREE_TO_TEN;
        else                                           bucket = RangeBucket.ABOVE_TEN;

        m.status        = MarketStatus.RESOLVED;
        m.winningBucket = bucket;
        m.resolutionTime = block.timestamp;

        // Check if winning bucket has any stakes
        if (rangePool[marketId][uint8(bucket)] == 0) {
            m.status = MarketStatus.CANCELLED;
            emit MarketCancelled(marketId);
            return;
        }

        emit MarketResolved(marketId, true, uint8(bucket));
    }

    /**
     * @notice Owner resolves a CUSTOM market.
     */
    function resolveCustom(uint256 marketId, bool outcome) external {
        require(msg.sender == IHypaFactory(factory).owner(), "not owner");
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.OPEN,        "not open");
        require(m.marketType == MarketType.CUSTOM,    "not custom");
        require(block.timestamp >= m.deadline,        "not expired");
        _resolveYesNo(marketId, outcome);
    }

    function _resolveYesNo(uint256 id, bool outcome) internal {
        Market storage m = markets[id];
        m.status         = MarketStatus.RESOLVED;
        m.outcome        = outcome;
        m.resolutionTime = block.timestamp;

        uint256 wp = outcome ? yesPool[id] : noPool[id];
        uint256 lp = outcome ? noPool[id]  : yesPool[id];

        if (wp == 0 || lp == 0) {
            m.status = MarketStatus.CANCELLED;
            emit MarketCancelled(id);
            return;
        }
        emit MarketResolved(id, outcome, outcome ? 1 : 0);
    }

    // ── claiming ──────────────────────────────────────────────────────────────

    /// @notice Claim winnings from a resolved binary market.
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.RESOLVED,  "not resolved");
        require(m.marketType != MarketType.POST_MCAP_RANGE, "use claimRange");
        require(!claimed[marketId][msg.sender],     "claimed");

        uint256 userStake     = m.outcome ? yesStakes[marketId][msg.sender] : noStakes[marketId][msg.sender];
        uint256 winningPool = m.outcome ? yesPool[marketId] : noPool[marketId];
        uint256 losingPool  = m.outcome ? noPool[marketId]  : yesPool[marketId];

        require(userStake > 0, "no winning stake");

        uint256 winnings = (losingPool * userStake) / winningPool + userStake;
        claimed[marketId][msg.sender] = true;
        _sendEth(msg.sender, winnings);
        emit WinningsClaimed(marketId, msg.sender, winnings);
    }

    /// @notice Claim winnings from a resolved range market.
    function claimRange(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.RESOLVED,               "not resolved");
        require(m.marketType == MarketType.POST_MCAP_RANGE,      "not range");
        require(!claimed[marketId][msg.sender],                  "claimed");

        uint8   wb         = uint8(m.winningBucket);
        uint256 userStake    = rangeStakes[marketId][wb][msg.sender];
        require(userStake > 0, "no winning stake");

        uint256 winningPool = rangePool[marketId][wb];
        uint256 losingTotal = 0;
        for (uint8 b = 0; b < 4; b++) {
            if (b != wb) losingTotal += rangePool[marketId][b];
        }

        uint256 winnings = (losingTotal * userStake) / winningPool + userStake;
        claimed[marketId][msg.sender] = true;
        _sendEth(msg.sender, winnings);
        emit WinningsClaimed(marketId, msg.sender, winnings);
    }

    /// @notice Refund on cancelled market.
    function refund(uint256 marketId) external nonReentrant {
        Market storage m = markets[marketId];
        require(m.status == MarketStatus.CANCELLED, "not cancelled");
        require(!claimed[marketId][msg.sender],     "claimed");

        uint256 total;
        if (m.marketType == MarketType.POST_MCAP_RANGE) {
            for (uint8 b = 0; b < 4; b++) total += rangeStakes[marketId][b][msg.sender];
        } else {
            total = yesStakes[marketId][msg.sender] + noStakes[marketId][msg.sender];
        }
        require(total > 0, "nothing to refund");
        claimed[marketId][msg.sender] = true;
        _sendEth(msg.sender, total);
    }

    // ── TWAP helpers ──────────────────────────────────────────────────────────

    function _getTwap(address pool, uint256 cumStart, uint256 tsStart)
        internal view returns (uint256 twap)
    {
        uint256 cumEnd = IUniswapV2Pair(pool).price0CumulativeLast();
        uint256 elapsed = block.timestamp - tsStart;
        require(elapsed > 0, "no time elapsed");
        // price0CumulativeLast is Q112.112 fixed point — divide by 2^112 to get normal price
        twap = (cumEnd - cumStart) / elapsed / (2**112);
    }

    function _computeMcap(address pool, uint256 pricePerToken)
        internal view returns (uint256 mcapInEth)
    {
        // mcap = totalSupply * pricePerToken
        // pricePerToken in ETH per token (18 decimals)
        // We use 1B total supply
        mcapInEth = (1_000_000_000e18 * pricePerToken) / 1e18;
    }

    // ── views ─────────────────────────────────────────────────────────────────

    function getMarket(uint256 id) external view returns (Market memory) { return markets[id]; }
    function getTokenMarkets(address t) external view returns (uint256[] memory) { return tokenMarkets[t]; }
    function getUserStakes(uint256 id, address u) external view returns (uint256 y, uint256 n) {
        return (yesStakes[id][u], noStakes[id][u]);
    }

    function pendingWinnings(uint256 marketId, address user) external view returns (uint256) {
        Market storage m = markets[marketId];
        if (m.status != MarketStatus.RESOLVED) return 0;
        if (claimed[marketId][user]) return 0;
        if (m.marketType == MarketType.POST_MCAP_RANGE) {
            uint8 wb = uint8(m.winningBucket);
            uint256 ub = rangeStakes[marketId][wb][user];
            if (ub == 0) return 0;
            uint256 wp = rangePool[marketId][wb];
            uint256 lp;
            for (uint8 b = 0; b < 4; b++) if (b != wb) lp += rangePool[marketId][b];
            return (lp * ub) / wp + ub;
        }
        uint256 ub  = m.outcome ? yesStakes[marketId][user] : noStakes[marketId][user];
        if (ub == 0) return 0;
        uint256 wp  = m.outcome ? yesPool[marketId] : noPool[marketId];
        uint256 lp  = m.outcome ? noPool[marketId]  : yesPool[marketId];
        return (lp * ub) / wp + ub;
    }

    // ── internal ──────────────────────────────────────────────────────────────

    function _popcount(uint8 x) internal pure returns (uint8 c) {
        while (x != 0) { c += x & 1; x >>= 1; }
    }

    function _sendEth(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok, "eth send failed");
    }

    receive() external payable {}
}

// ── interfaces ────────────────────────────────────────────────────────────────

interface IBondingCurve {
    function graduated()      external view returns (bool);
    function realEthReserve() external view returns (uint256);
    function currentPrice()   external view returns (uint256);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function price0CumulativeLast() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IHypaFactory {
    function owner() external view returns (address);
}
