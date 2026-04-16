// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint);
    function transfer(address, uint) external returns (bool);
    function transferFrom(address, address, uint) external returns (bool);
    function approve(address, uint) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint) external;
    function transfer(address, uint) external returns (bool);
    function balanceOf(address) external view returns (uint);
}

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function mint(address) external returns (uint);
    function burn(address) external returns (uint, uint);
    function swap(uint, uint, address, bytes calldata) external;
    function price0CumulativeLast() external view returns (uint);
    function price1CumulativeLast() external view returns (uint);
}

/**
 * @title UniswapV2Router02
 * @notice Minimal Uniswap V2 Router supporting:
 *   - addLiquidityETH
 *   - removeLiquidityETH
 *   - swapExactETHForTokens
 *   - swapExactTokensForETH
 *   - swapExactTokensForTokens
 *   - getAmountsOut / getAmountsIn
 */
contract UniswapV2Router02 {

    address public immutable factory;
    address public immutable WETH;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
        _;
    }

    constructor(address _factory, address _WETH) {
        factory = _factory;
        WETH    = _WETH;
    }

    receive() external payable {
        assert(msg.sender == WETH);
    }

    // ── internal helpers ──────────────────────────────────────────────────────

    function _pairFor(address tokenA, address tokenB) internal view returns (address pair) {
        pair = IUniswapV2Factory(factory).getPair(tokenA, tokenB);
        require(pair != address(0), "UniswapV2Router: PAIR_NOT_FOUND");
    }

    function _getReserves(address tokenA, address tokenB)
        internal view returns (uint reserveA, uint reserveB)
    {
        (address token0,) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(_pairFor(tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (uint(r0), uint(r1)) : (uint(r1), uint(r0));
    }

    function _quote(uint amountA, uint reserveA, uint reserveB)
        internal pure returns (uint amountB)
    {
        require(amountA > 0, "UniswapV2Router: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "UniswapV2Router: INSUFFICIENT_LIQUIDITY");
        amountB = amountA * reserveB / reserveA;
    }

    function _getAmountOut(uint amountIn, uint reserveIn, uint reserveOut)
        internal pure returns (uint amountOut)
    {
        require(amountIn > 0, "UniswapV2Router: INSUFFICIENT_INPUT");
        require(reserveIn > 0 && reserveOut > 0, "UniswapV2Router: INSUFFICIENT_LIQUIDITY");
        uint amountInWithFee = amountIn * 997;
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * 1000 + amountInWithFee);
    }

    function _getAmountIn(uint amountOut, uint reserveIn, uint reserveOut)
        internal pure returns (uint amountIn)
    {
        require(amountOut > 0, "UniswapV2Router: INSUFFICIENT_OUTPUT");
        require(reserveIn > 0 && reserveOut > 0, "UniswapV2Router: INSUFFICIENT_LIQUIDITY");
        amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function _addLiquidity(
        address tokenA, address tokenB,
        uint amountADesired, uint amountBDesired,
        uint amountAMin, uint amountBMin
    ) internal returns (uint amountA, uint amountB) {
        if (IUniswapV2Factory(factory).getPair(tokenA, tokenB) == address(0)) {
            IUniswapV2Factory(factory).createPair(tokenA, tokenB);
        }
        (uint reserveA, uint reserveB) = _getReserves(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint amountBOptimal = _quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, "UniswapV2Router: INSUFFICIENT_B");
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint amountAOptimal = _quote(amountBDesired, reserveB, reserveA);
                require(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, "UniswapV2Router: INSUFFICIENT_A");
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function _swap(uint[] memory amounts, address[] memory path, address _to) internal {
        for (uint i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            address token0 = input < output ? input : output;
            uint amountOut = amounts[i + 1];
            (uint amount0Out, uint amount1Out) = input == token0
                ? (uint(0), amountOut)
                : (amountOut, uint(0));
            address to = i < path.length - 2
                ? IUniswapV2Factory(factory).getPair(output, path[i + 2])
                : _to;
            IUniswapV2Pair(IUniswapV2Factory(factory).getPair(input, output))
                .swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint value) internal {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSelector(0x23b872dd, from, to, value)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferFrom failed");
    }

    // ── liquidity ─────────────────────────────────────────────────────────────

    function addLiquidity(
        address tokenA, address tokenB,
        uint amountADesired, uint amountBDesired,
        uint amountAMin, uint amountBMin,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint amountA, uint amountB, uint liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = IUniswapV2Factory(factory).getPair(tokenA, tokenB);
        if (pair == address(0)) pair = IUniswapV2Factory(factory).createPair(tokenA, tokenB);
        _safeTransferFrom(tokenA, msg.sender, pair, amountA);
        _safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = IUniswapV2Pair(pair).mint(to);
    }

    function addLiquidityETH(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external payable ensure(deadline) returns (uint amountToken, uint amountETH, uint liquidity) {
        (amountToken, amountETH) = _addLiquidity(
            token, WETH, amountTokenDesired, msg.value, amountTokenMin, amountETHMin
        );
        address pair = IUniswapV2Factory(factory).getPair(token, WETH);
        if (pair == address(0)) pair = IUniswapV2Factory(factory).createPair(token, WETH);

        _safeTransferFrom(token, msg.sender, pair, amountToken);
        IWETH(WETH).deposit{value: amountETH}();
        IWETH(WETH).transfer(pair, amountETH);
        liquidity = IUniswapV2Pair(pair).mint(to);

        // Refund excess ETH
        if (msg.value > amountETH) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - amountETH}("");
            require(ok, "ETH refund failed");
        }
    }

    function removeLiquidityETH(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountETHMin,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint amountToken, uint amountETH) {
        address pair = _pairFor(token, WETH);
        IERC20(pair).transferFrom(msg.sender, pair, liquidity);
        (uint amount0, uint amount1) = IUniswapV2Pair(pair).burn(address(this));
        address token0 = IUniswapV2Pair(pair).token0();
        (amountToken, amountETH) = token == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountToken >= amountTokenMin, "UniswapV2Router: INSUFFICIENT_TOKEN");
        require(amountETH >= amountETHMin,     "UniswapV2Router: INSUFFICIENT_ETH");
        IERC20(token).transfer(to, amountToken);
        IWETH(WETH).withdraw(amountETH);
        (bool ok,) = payable(to).call{value: amountETH}("");
        require(ok, "ETH transfer failed");
    }

    // ── swaps ─────────────────────────────────────────────────────────────────

    function swapExactETHForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable ensure(deadline) returns (uint[] memory amounts) {
        require(path[0] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT");
        IWETH(WETH).deposit{value: amounts[0]}();
        IWETH(WETH).transfer(IUniswapV2Factory(factory).getPair(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    function swapExactTokensForETH(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts) {
        require(path[path.length - 1] == WETH, "UniswapV2Router: INVALID_PATH");
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT");
        _safeTransferFrom(path[0], msg.sender, IUniswapV2Factory(factory).getPair(path[0], path[1]), amounts[0]);
        _swap(amounts, path, address(this));
        IWETH(WETH).withdraw(amounts[amounts.length - 1]);
        (bool ok,) = payable(to).call{value: amounts[amounts.length - 1]}("");
        require(ok, "ETH transfer failed");
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT");
        _safeTransferFrom(path[0], msg.sender, IUniswapV2Factory(factory).getPair(path[0], path[1]), amounts[0]);
        _swap(amounts, path, to);
    }

    // ── views ─────────────────────────────────────────────────────────────────

    function getAmountsOut(uint amountIn, address[] memory path)
        public view returns (uint[] memory amounts)
    {
        require(path.length >= 2, "UniswapV2Router: INVALID_PATH");
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        for (uint i; i < path.length - 1; i++) {
            (uint reserveIn, uint reserveOut) = _getReserves(path[i], path[i + 1]);
            amounts[i + 1] = _getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    function getAmountsIn(uint amountOut, address[] memory path)
        public view returns (uint[] memory amounts)
    {
        require(path.length >= 2, "UniswapV2Router: INVALID_PATH");
        amounts = new uint[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint i = path.length - 1; i > 0; i--) {
            (uint reserveIn, uint reserveOut) = _getReserves(path[i - 1], path[i]);
            amounts[i - 1] = _getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }

    function quote(uint amountA, uint reserveA, uint reserveB)
        external pure returns (uint amountB)
    {
        return _quote(amountA, reserveA, reserveB);
    }
}
