"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowsLeftRight, PencilSimple } from "@phosphor-icons/react";
import { getPublicClient } from "@wagmi/core";
import type { Config } from "@wagmi/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { waitForTransactionReceipt } from "viem/actions";
import {
  type Address,
  formatEther,
  formatUnits,
  maxUint256,
  parseEther,
  parseUnits,
} from "viem";
import {
  useAccount,
  useBalance,
  useConfig,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { bondingCurveTradeAbi } from "../../lib/abis/bonding-curve-trade";
import { erc20BalanceAllowanceAbi } from "../../lib/abis/erc20-trade";
import { deployments } from "../../lib/deployments";
import { SwapPanel } from "../swap/swap-panel";

async function waitTxConfirmed(config: Config, chainId: number, hash: `0x${string}`) {
  const pc = getPublicClient(config, { chainId });
  if (!pc) throw new Error("No public client for chain");
  await waitForTransactionReceipt(pc, { hash });
}

function slipBps(slippagePct: number): bigint {
  const x = Math.round(slippagePct * 100);
  if (!Number.isFinite(x) || x < 0) return BigInt(0);
  if (x > 5000) return BigInt(5000);
  return BigInt(x);
}

function minOutAfterSlippage(quoted: bigint, slippagePct: number): bigint {
  const bps = slipBps(slippagePct);
  return (quoted * (BigInt(10000) - bps)) / BigInt(10000);
}

const BPS = BigInt(10_000);
const BUY_FEE_BPS = BigInt(100); // 1%

/** Explicit gas caps so wallets don’t under-estimate `buy` (graduation is one heavy tx). */
const BUY_GAS_LIMIT_NORMAL = BigInt(1200000);
const BUY_GAS_LIMIT_GRADUATION = BigInt(25000000);

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

function commifyInt(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatAmount(value: bigint, decimals: number, maxFrac = 4): string {
  const raw = formatUnits(value, decimals);
  const [i, f = ""] = raw.split(".");
  const trimmed = f.replace(/0+$/, "").slice(0, maxFrac);
  return trimmed ? `${commifyInt(i)}.${trimmed}` : commifyInt(i);
}

function formatInputAmount(value: bigint, decimals: number, maxFrac = 6): string {
  const raw = formatUnits(value, decimals);
  const [i, f = ""] = raw.split(".");
  const trimmed = f.replace(/0+$/, "").slice(0, maxFrac);
  return trimmed ? `${i}.${trimmed}` : i;
}

/** ETH amount field: keeps all significant digits (up to 18) so sub‑micro ETH is not clipped to `0.000000`). */
function formatEthWeiFullTrim(wei: bigint): string {
  if (wei <= BigInt(0)) return "0";
  const s = formatEther(wei);
  if (!s.includes(".")) return s;
  const [i, frac = ""] = s.split(".");
  const t = frac.replace(/0+$/, "");
  return t.length ? `${i}.${t}` : i;
}

const DUST_ETH_DISPLAY_WEI = parseEther("0.000001");

/** Labels / errors: never show a misleading all‑zero ETH cap when the real value is dust before graduation. */
function formatEthCapForDisplay(wei: bigint): string {
  if (wei <= BigInt(0)) return "0";
  if (wei < DUST_ETH_DISPLAY_WEI) {
    return `${formatEthWeiFullTrim(wei)} ETH (${wei.toString()} wei)`;
  }
  return `${formatAmount(wei, 18, 6)} ETH`;
}

function formatEthFeeEst(feeWei: bigint | null): string {
  if (feeWei === null) return "—";
  if (feeWei === BigInt(0)) return "0 ETH";
  if (feeWei < DUST_ETH_DISPLAY_WEI) return `${formatEthWeiFullTrim(feeWei)} ETH`;
  return `${formatAmount(feeWei, 18, 6)} ETH`;
}

function requiredEthInForTokensOut(
  tokensOut: bigint,
  virtualTokenReserve: bigint,
  virtualEthReserve: bigint,
): bigint | null {
  if (tokensOut <= BigInt(0) || tokensOut >= virtualTokenReserve) return null;
  const e = ceilDiv(tokensOut * virtualEthReserve, virtualTokenReserve - tokensOut);
  return ceilDiv(e * BPS, BPS - BUY_FEE_BPS);
}

function maxTokensInForGrossEthOut(
  grossEth: bigint,
  virtualTokenReserve: bigint,
  virtualEthReserve: bigint,
): bigint | null {
  if (grossEth <= BigInt(0) || grossEth >= virtualEthReserve) return null;
  return (grossEth * virtualTokenReserve) / (virtualEthReserve - grossEth);
}

/** Same integer math as `BondingCurveV2.quoteBuy` / `buy` (fee then constant product). */
function buyTokensOutForGrossEth(
  grossWei: bigint,
  virtualTokenReserve: bigint,
  virtualEthReserve: bigint,
): bigint {
  if (grossWei <= BigInt(0)) return BigInt(0);
  const fee = (grossWei * BUY_FEE_BPS) / BPS;
  const ethAfterFee = grossWei - fee;
  return (
    virtualTokenReserve -
    (virtualTokenReserve * virtualEthReserve) / (virtualEthReserve + ethAfterFee)
  );
}

const ABSURD_GROSS_ETH_WEI = parseEther("1000000");

/**
 * Maximum gross ETH send such that `buyTokensOutForGrossEth(g) <= tokenBalance`.
 * `requiredEthInForTokensOut(balance)` uses ceil inverses and can overshoot by wei so on-chain `quoteBuy` > balance.
 */
function maxGrossEthWithTokensOutAtMost(
  tokenBalance: bigint,
  virtualTokenReserve: bigint,
  virtualEthReserve: bigint,
  hardCeiling: bigint | null,
): bigint | null {
  if (tokenBalance <= BigInt(0)) return null;
  const f = (g: bigint) => buyTokensOutForGrossEth(g, virtualTokenReserve, virtualEthReserve);
  if (f(BigInt(1)) > tokenBalance) return null;

  let hi = requiredEthInForTokensOut(tokenBalance, virtualTokenReserve, virtualEthReserve) ?? BigInt(1);
  if (hardCeiling !== null && hi > hardCeiling) hi = hardCeiling;

  if (f(hi) <= tokenBalance) {
    while (hi < ABSURD_GROSS_ETH_WEI) {
      const doubled = hi * BigInt(2);
      const next = hardCeiling !== null ? (doubled > hardCeiling ? hardCeiling : doubled) : doubled;
      if (next <= hi) break;
      hi = next;
      if (f(hi) > tokenBalance) break;
      if (hardCeiling !== null && hi >= hardCeiling) return hi;
    }
    if (f(hi) <= tokenBalance) return hi;
  }

  let lo = BigInt(1);
  let ans = BigInt(0);
  while (lo <= hi) {
    const mid = lo + (hi - lo) / BigInt(2);
    if (f(mid) <= tokenBalance) {
      ans = mid;
      lo = mid + BigInt(1);
    } else {
      hi = mid - BigInt(1);
    }
  }
  return ans > BigInt(0) ? ans : null;
}

type Side = "buy" | "sell";
type BuyInputUnit = "eth" | "token";

export function CurveTradePanel({
  tokenAddress,
  curveAddress,
  symbol,
}: {
  tokenAddress: Address;
  curveAddress: Address;
  symbol: string;
}) {
  const deployChainId = deployments.chainId;
  const config = useConfig();
  const queryClient = useQueryClient();
  const { address, isConnected } = useAccount();
  const { writeContractAsync, isPending: isWritePending } = useWriteContract();

  const [side, setSide] = useState<Side>("buy");
  const [buyInputUnit, setBuyInputUnit] = useState<BuyInputUnit>("eth");
  const [amount, setAmount] = useState("");
  const [slippagePct, setSlippagePct] = useState(1.5);
  const [slippageModalOpen, setSlippageModalOpen] = useState(false);
  const slippageMenuRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: decimals = 18 } = useReadContract({
    address: tokenAddress,
    abi: erc20BalanceAllowanceAbi,
    functionName: "decimals",
    chainId: deployChainId,
  });

  const { data: graduated } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "graduated",
    chainId: deployChainId,
  });

  const { data: curveToken } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "token",
    chainId: deployChainId,
  });

  const tokenMismatch =
    curveToken !== undefined &&
    (curveToken as string).toLowerCase() !== tokenAddress.toLowerCase();

  const { data: currentPrice } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "currentPrice",
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });
  const { data: gradTarget } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "GRADUATION_ETH_TARGET",
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });

  const { data: realEthReserve } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "realEthReserve",
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });
  const { data: virtualTokenReserve } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "virtualTokenReserve",
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });
  const { data: virtualEthReserve } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "virtualEthReserve",
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });

  const { data: curveTokenBalance } = useReadContract({
    address: tokenAddress,
    abi: erc20BalanceAllowanceAbi,
    functionName: "balanceOf",
    args: [curveAddress],
    chainId: deployChainId,
    query: { enabled: graduated === false },
  });

  const { data: ethUsd } = useQuery({
    queryKey: ["eth-usd", "trade-panel"],
    queryFn: async () => {
      const r = await fetch("/api/eth-usd");
      const d = (await r.json()) as { usd?: number };
      if (!r.ok || typeof d.usd !== "number") throw new Error("eth-usd failed");
      return d.usd;
    },
    staleTime: 60_000,
  });

  const { data: ethBal } = useBalance({
    address,
    chainId: deployChainId,
    query: { enabled: Boolean(address) },
  });

  const { data: tokenBal } = useReadContract({
    address: tokenAddress,
    abi: erc20BalanceAllowanceAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: deployChainId,
    query: { enabled: Boolean(address) },
  });

  const { data: allowance } = useReadContract({
    address: tokenAddress,
    abi: erc20BalanceAllowanceAbi,
    functionName: "allowance",
    args: address ? [address, curveAddress] : undefined,
    chainId: deployChainId,
    query: { enabled: Boolean(address) && side === "sell" },
  });

  const amountWeiParsed = useMemo(() => {
    const t = amount.trim();
    if (!t) return null;
    try {
      const w =
        side === "buy"
          ? buyInputUnit === "eth"
            ? parseEther(t)
            : parseUnits(t, decimals)
          : parseUnits(t, decimals);
      return w > BigInt(0) ? w : null;
    } catch {
      return null;
    }
  }, [amount, buyInputUnit, decimals, side]);

  const ethInWei = useMemo(() => {
    if (side !== "buy" || amountWeiParsed === null) return null;
    if (buyInputUnit === "eth") return amountWeiParsed;
    if (virtualTokenReserve === undefined || virtualEthReserve === undefined) return null;
    return requiredEthInForTokensOut(
      amountWeiParsed,
      virtualTokenReserve as bigint,
      virtualEthReserve as bigint,
    );
  }, [amountWeiParsed, buyInputUnit, side, virtualEthReserve, virtualTokenReserve]);

  const tokenInWei = useMemo(() => {
    if (side !== "sell") return null;
    return amountWeiParsed;
  }, [amountWeiParsed, side]);

  const { data: quoteBuy } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "quoteBuy",
    args: ethInWei !== null ? [ethInWei] : undefined,
    chainId: deployChainId,
    query: { enabled: graduated === false && ethInWei !== null },
  });

  const { data: quoteSell } = useReadContract({
    address: curveAddress,
    abi: bondingCurveTradeAbi,
    functionName: "quoteSell",
    args: tokenInWei !== null ? [tokenInWei] : undefined,
    chainId: deployChainId,
    query: { enabled: graduated === false && tokenInWei !== null },
  });

  const tokensOutEst =
    quoteBuy && Array.isArray(quoteBuy) ? (quoteBuy[0] as bigint) : null;
  const buyFeeEst =
    quoteBuy && Array.isArray(quoteBuy) ? (quoteBuy[1] as bigint) : null;
  const ethOutEst =
    quoteSell && Array.isArray(quoteSell) ? (quoteSell[0] as bigint) : null;
  const sellFeeEst =
    quoteSell && Array.isArray(quoteSell) ? (quoteSell[1] as bigint) : null;

  const minTokensBuy =
    tokensOutEst !== null ? minOutAfterSlippage(tokensOutEst, slippagePct) : null;
  const minEthSell =
    ethOutEst !== null ? minOutAfterSlippage(ethOutEst, slippagePct) : null;

  /** Graduation runs `seedLiquidity` inside the same tx — needs much more gas than a normal buy. */
  const buyTriggersGraduation = useMemo(() => {
    if (graduated !== false || ethInWei === null || buyFeeEst === null) return false;
    if (realEthReserve === undefined || gradTarget === undefined) return false;
    const ethAfter = ethInWei - buyFeeEst;
    return (realEthReserve as bigint) + ethAfter >= (gradTarget as bigint);
  }, [graduated, ethInWei, buyFeeEst, realEthReserve, gradTarget]);

  const spotEthPerTokenWei = useMemo(() => {
    if (currentPrice === undefined || currentPrice === null) return null;
    const p = currentPrice as bigint;
    if (p <= BigInt(0)) return null;
    return formatEther(p);
  }, [currentPrice]);
  const spotUsdPerToken = useMemo(() => {
    if (!spotEthPerTokenWei || ethUsd === undefined) return null;
    const x = Number(spotEthPerTokenWei) * ethUsd;
    return Number.isFinite(x) ? x : null;
  }, [ethUsd, spotEthPerTokenWei]);

  // Net ETH gap: how much more needs to land in the reserve to hit graduation target.
  const ethLeftToGrad = useMemo(() => {
    if (gradTarget === undefined || realEthReserve === undefined) return null;
    const left = (gradTarget as bigint) - (realEthReserve as bigint);
    return left > BigInt(0) ? left : BigInt(0);
  }, [gradTarget, realEthReserve]);

  // Gross ETH to SEND so that after the 1% fee the reserve gets exactly ethLeftToGrad.
  // gross = ceil(net × BPS / (BPS - feeBps))
  const ethToSendForGrad = useMemo(() => {
    if (ethLeftToGrad === null || ethLeftToGrad <= BigInt(0)) return null;
    return ceilDiv(ethLeftToGrad * BPS, BPS - BUY_FEE_BPS);
  }, [ethLeftToGrad]);

  // Max tokens buyable with the remaining gross ETH headroom (for token-input mode cap).
  const maxTokensBeforeGrad = useMemo(() => {
    if (
      ethToSendForGrad === null ||
      ethToSendForGrad <= BigInt(0) ||
      virtualTokenReserve === undefined ||
      virtualEthReserve === undefined
    ) return null;
    return maxTokensInForGrossEthOut(
      ethToSendForGrad,
      virtualTokenReserve as bigint,
      virtualEthReserve as bigint,
    );
  }, [ethToSendForGrad, virtualTokenReserve, virtualEthReserve]);

  // Also keep the AMM-based ETH cost to buy ALL tokens (used for fill button in token mode).
  const maxEthForAllTokens = useMemo(() => {
    if (
      curveTokenBalance === undefined ||
      virtualTokenReserve === undefined ||
      virtualEthReserve === undefined
    ) return null;
    const maxTokens = curveTokenBalance as bigint;
    if (maxTokens <= BigInt(0)) return null;
    return maxGrossEthWithTokensOutAtMost(
      maxTokens,
      virtualTokenReserve as bigint,
      virtualEthReserve as bigint,
      null,
    );
  }, [curveTokenBalance, virtualTokenReserve, virtualEthReserve]);

  /** Gross ETH (fee-inclusive) the user may send: both graduation headroom and tokens on the curve. */
  const maxGrossEthBuy = useMemo(() => {
    const caps: bigint[] = [];
    if (ethToSendForGrad !== null && ethToSendForGrad > BigInt(0)) caps.push(ethToSendForGrad);
    if (maxEthForAllTokens !== null && maxEthForAllTokens > BigInt(0)) caps.push(maxEthForAllTokens);
    if (caps.length === 0) return null;
    return caps.reduce((a, b) => (a < b ? a : b));
  }, [ethToSendForGrad, maxEthForAllTokens]);

  // Fires immediately from raw input so we don't need to wait for a quote round-trip.
  const exceedsCurveTokenPool =
    side === "buy" &&
    amountWeiParsed !== null &&
    (buyInputUnit === "token"
      ? // token mode: cap is actual tokens the curve holds AND tokens reachable before grad
        (curveTokenBalance !== undefined && amountWeiParsed > (curveTokenBalance as bigint)) ||
        (maxTokensBeforeGrad !== null && amountWeiParsed > maxTokensBeforeGrad)
      : // eth mode: cap by graduation and by virtual AMM vs physical token inventory ("curve empty" on-chain)
        maxGrossEthBuy !== null && amountWeiParsed > maxGrossEthBuy);

  const exceedsUserEthBalance =
    side === "buy" &&
    isConnected &&
    ethBal?.value !== undefined &&
    ethInWei !== null &&
    ethInWei > ethBal.value;

  const exceedsUserTokenBalance =
    side === "sell" &&
    tokenBal !== undefined &&
    tokenInWei !== null &&
    tokenInWei > (tokenBal as bigint);
  const exceedsCurveEthPool =
    side === "sell" &&
    realEthReserve !== undefined &&
    ethOutEst !== null &&
    sellFeeEst !== null &&
    ethOutEst + sellFeeEst > (realEthReserve as bigint);

  const onBuy = useCallback(async () => {
    setError(null);
    if (!address) {
      setError("Connect your wallet.");
      return;
    }
    if (ethInWei === null) {
      setError("Enter a valid ETH amount.");
      return;
    }
    if (exceedsUserEthBalance) {
      const bal = ethBal?.value !== undefined ? formatAmount(ethBal.value, 18, 6) : "?";
      setError(`Insufficient ETH balance. You have ${bal} ETH.`);
      return;
    }
    if (exceedsCurveTokenPool) {
      if (buyInputUnit === "eth") {
        const left = maxGrossEthBuy !== null ? formatEthCapForDisplay(maxGrossEthBuy) : "?";
        setError(`Exceeds curve capacity — max ${left} (fees incl.) for this state.`);
      } else {
        const maxTok = maxTokensBeforeGrad !== null ? formatAmount(maxTokensBeforeGrad, decimals, 4) : "?";
        setError(`Max ${maxTok} ${symbol} buyable before graduation.`);
      }
      return;
    }
    if (minTokensBuy === null) {
      setError("Quote unavailable.");
      return;
    }
    try {
      setSuccessMsg(null);
      const hash = await writeContractAsync({
        address: curveAddress,
        abi: bondingCurveTradeAbi,
        functionName: "buy",
        args: [minTokensBuy],
        value: ethInWei,
        chainId: deployChainId,
        gas: buyTriggersGraduation ? BUY_GAS_LIMIT_GRADUATION : BUY_GAS_LIMIT_NORMAL,
      });
      await waitTxConfirmed(config, deployChainId, hash);
      setAmount("");
      const received = tokensOutEst !== null ? formatAmount(tokensOutEst, decimals, 4) : null;
      setSuccessMsg(received ? `Bought ${received} ${symbol}` : "Buy confirmed");
      await queryClient.invalidateQueries();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Buy failed";
      const low = msg.toLowerCase();
      if (low.includes("gas")) {
        setError(
          "This buy needs more gas (common when it triggers graduation). Try again, or raise the gas limit in your wallet under Advanced.",
        );
      } else if (low.includes("curve empty")) {
        setError(
          "The curve does not have enough tokens for that size (AMM output exceeds inventory). Use a smaller ETH amount or try Fill max.",
        );
      } else {
        setError(msg);
      }
    }
  }, [
    address,
    buyInputUnit,
    buyTriggersGraduation,
    config,
    curveAddress,
    curveTokenBalance,
    decimals,
    deployChainId,
    ethBal?.value,
    ethInWei,
    exceedsCurveTokenPool,
    exceedsUserEthBalance,
    maxGrossEthBuy,
    maxTokensBeforeGrad,
    minTokensBuy,
    queryClient,
    symbol,
    tokensOutEst,
    writeContractAsync,
  ]);

  const onSell = useCallback(async () => {
    setError(null);
    if (!address) {
      setError("Connect your wallet.");
      return;
    }
    if (tokenInWei === null) {
      setError("Enter a valid token amount.");
      return;
    }
    if (tokenBal !== undefined && tokenInWei > (tokenBal as bigint)) {
      setError("Amount exceeds your token balance.");
      return;
    }
    if (minEthSell === null) {
      setError("Quote unavailable.");
      return;
    }
    if (
      realEthReserve !== undefined &&
      ethOutEst !== null &&
      sellFeeEst !== null &&
      ethOutEst + sellFeeEst > (realEthReserve as bigint)
    ) {
      setError("Amount exceeds available ETH in curve pool.");
      return;
    }
    try {
      const need =
        allowance === undefined || allowance === null
          ? true
          : (allowance as bigint) < tokenInWei;
      if (need) {
        const h = await writeContractAsync({
          address: tokenAddress,
          abi: erc20BalanceAllowanceAbi,
          functionName: "approve",
          args: [curveAddress, maxUint256],
          chainId: deployChainId,
        });
        await waitTxConfirmed(config, deployChainId, h);
        await queryClient.invalidateQueries();
      }
      const hash = await writeContractAsync({
        address: curveAddress,
        abi: bondingCurveTradeAbi,
        functionName: "sell",
        args: [tokenInWei, minEthSell],
        chainId: deployChainId,
      });
      await waitTxConfirmed(config, deployChainId, hash);
      setAmount("");
      const received = ethOutEst !== null ? formatAmount(ethOutEst, 18, 6) : null;
      setSuccessMsg(received ? `Sold for ${received} ETH` : "Sell confirmed");
      await queryClient.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sell failed");
    }
  }, [
    address,
    allowance,
    config,
    curveAddress,
    deployChainId,
    minEthSell,
    realEthReserve,
    queryClient,
    sellFeeEst,
    tokenBal,
    tokenAddress,
    tokenInWei,
    ethOutEst,
    writeContractAsync,
  ]);

  const busy = isWritePending;

  const fillMaxBuy = useCallback(() => {
    if (buyInputUnit === "token") {
      // Fill with max tokens reachable before graduation (or full balance if no grad constraint)
      const cap = maxTokensBeforeGrad !== null
        ? (curveTokenBalance !== undefined ? (maxTokensBeforeGrad < (curveTokenBalance as bigint) ? maxTokensBeforeGrad : (curveTokenBalance as bigint)) : maxTokensBeforeGrad)
        : curveTokenBalance !== undefined ? (curveTokenBalance as bigint) : null;
      if (cap !== null) setAmount(formatInputAmount(cap, decimals, 6));
      return;
    }
    // ETH mode: min(graduation headroom, ETH to buy every token the curve holds)
    if (maxGrossEthBuy !== null) setAmount(formatEthWeiFullTrim(maxGrossEthBuy));
    else if (ethToSendForGrad !== null) setAmount(formatEthWeiFullTrim(ethToSendForGrad));
    else if (maxEthForAllTokens !== null) setAmount(formatEthWeiFullTrim(maxEthForAllTokens));
  }, [
    buyInputUnit,
    curveTokenBalance,
    decimals,
    ethToSendForGrad,
    maxEthForAllTokens,
    maxGrossEthBuy,
    maxTokensBeforeGrad,
  ]);

  const fillMaxSellBalance = useCallback(() => {
    if (tokenBal === undefined) return;
    setAmount(formatInputAmount(tokenBal as bigint, decimals, 6));
  }, [decimals, tokenBal]);

  const fillMaxSellPool = useCallback(() => {
    if (realEthReserve === undefined || virtualTokenReserve === undefined || virtualEthReserve === undefined) return;
    const maxTokens = maxTokensInForGrossEthOut(
      realEthReserve as bigint,
      virtualTokenReserve as bigint,
      virtualEthReserve as bigint,
    );
    if (maxTokens !== null) setAmount(formatInputAmount(maxTokens, decimals, 6));
  }, [decimals, realEthReserve, virtualEthReserve, virtualTokenReserve]);

  useEffect(() => {
    if (!slippageModalOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (slippageMenuRef.current && !slippageMenuRef.current.contains(e.target as Node)) {
        setSlippageModalOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSlippageModalOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [slippageModalOpen]);

  if (tokenMismatch) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/30 p-4 text-[0.875rem] text-red-200">
        This bonding curve is not wired to this token address.
      </div>
    );
  }

  if (graduated === true) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/90 p-2 shadow-sm">
        <div className="mb-2 px-1">
          <h2 className="font-heading text-base font-semibold text-fg">Trade</h2>
          
        </div>
        <SwapPanel initialTokenAddress={tokenAddress} compact />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface-elevated/90 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-heading text-base font-semibold text-fg">Trade</h2>
          <p className="mt-0.5 text-[0.7rem] text-muted">Bonding curve</p>
        </div>
        <div ref={slippageMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setSlippageModalOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-team transition-colors hover:bg-surface-hover hover:text-fg"
            aria-label="Trade settings"
            title="Trade settings"
          >
            <PencilSimple size={14} />
            <span className="font-mono text-[0.74rem] text-fg">{slippagePct.toFixed(1)}%</span>
          </button>
          {slippageModalOpen ? (
            <div
              role="dialog"
              aria-modal="false"
              aria-label="Slippage settings"
              className="absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-border bg-surface-elevated p-3 shadow-2xl"
            >
              <p className="mb-2 text-[0.72rem] font-medium text-muted">Slippage tolerance</p>
              <div className="flex items-center gap-1.5">
                {[0.5, 1.0, 1.5, 3.0].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setSlippagePct(v)}
                    className={`rounded-md px-2 py-1 text-[0.75rem] font-mono transition-colors ${
                      slippagePct === v ? "bg-accent text-fg" : "text-team hover:bg-surface-hover hover:text-fg"
                    }`}
                  >
                    {v}%
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-canvas px-2 py-1.5">
                <input
                  type="number"
                  min={0.1}
                  max={15}
                  step={0.1}
                  value={slippagePct}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isFinite(n)) return;
                    setSlippagePct(Math.max(0.1, Math.min(15, n)));
                  }}
                  className="w-full bg-transparent text-right font-mono text-[0.82rem] text-fg outline-none"
                />
                <span className="text-[0.72rem] text-muted">%</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-canvas/40 p-1">
        <button
          type="button"
          onClick={() => {
            setSide("buy");
            setAmount("");
            setError(null);
            setSuccessMsg(null);
          }}
          className={`rounded-md py-2 text-[0.8125rem] font-semibold transition-colors ${
            side === "buy"
              ? "bg-accent text-fg shadow-sm"
              : "text-team hover:text-fg"
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => {
            setSide("sell");
            setAmount("");
            setError(null);
            setSuccessMsg(null);
          }}
          className={`rounded-md py-2 text-[0.8125rem] font-semibold transition-colors ${
            side === "sell"
              ? "bg-red-600 text-white shadow-sm"
              : "text-team hover:text-fg"
          }`}
        >
          Sell
        </button>
      </div>

      {spotUsdPerToken !== null ? (
        <p className="mt-2 text-[0.72rem] text-team">
          Price: <span className="font-mono text-fg">${spotUsdPerToken.toFixed(6)}</span>
        </p>
      ) : null}

      <div className="mt-2">
        <label className="text-[0.7rem] font-medium uppercase tracking-wide text-muted">
          {side === "buy"
            ? buyInputUnit === "eth"
              ? "Amount (ETH)"
              : `Amount (${symbol})`
            : `Amount (${symbol})`}
        </label>
        <div className="relative mt-1">
          <input
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setSuccessMsg(null); }}
            inputMode="decimal"
            placeholder={
              side === "buy"
                ? buyInputUnit === "eth"
                  ? "0.0 ETH"
                  : `0 ${symbol}`
                : `0 ${symbol}`
            }
            className="w-full rounded-lg border border-border bg-canvas px-2.5 py-2 pr-9 font-mono text-[0.875rem] text-fg outline-none focus:border-accent"
          />
          {side === "buy" ? (
            <button
              type="button"
              onClick={() =>
                setBuyInputUnit((u) => (u === "eth" ? "token" : "eth"))
              }
              className="absolute inset-y-0 right-1 my-1 inline-flex items-center justify-center rounded-md px-2 text-team hover:bg-surface-hover hover:text-fg"
              title={`Swap input unit (${buyInputUnit === "eth" ? "ETH → " + symbol : symbol + " → ETH"})`}
              aria-label="Swap buy input unit"
            >
              <ArrowsLeftRight size={14} />
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-[0.72rem] text-muted">
          Balance:{" "}
          {side === "buy"
            ? isConnected && ethBal?.value !== undefined
              ? `${formatAmount(ethBal.value, 18, 4)} ETH`
              : "—"
            : isConnected && tokenBal !== undefined
              ? `${formatAmount(tokenBal as bigint, decimals, 4)} ${symbol}`
              : "—"}
        </p>
        {exceedsUserEthBalance && ethBal?.value !== undefined ? (
          <button
            type="button"
            onClick={() => setAmount(formatInputAmount(ethBal.value, 18, 6))}
            className="mt-1 text-left text-[0.72rem] text-red-300 underline underline-offset-2 hover:text-red-200"
          >
            {`Insufficient balance — you only have ${formatAmount(ethBal.value, 18, 6)} ETH — click to fill`}
          </button>
        ) : null}
        {exceedsCurveTokenPool ? (
          <button
            type="button"
            onClick={fillMaxBuy}
            className="mt-1 text-left text-[0.72rem] text-red-300 underline underline-offset-2 hover:text-red-200"
          >
            {buyInputUnit === "eth"
              ? `Max ${maxGrossEthBuy !== null ? formatEthCapForDisplay(maxGrossEthBuy) : "?"} (fees incl.) for this curve — click to fill`
              : `Max ${maxTokensBeforeGrad !== null ? formatAmount(maxTokensBeforeGrad, decimals, 4) : curveTokenBalance !== undefined ? formatAmount(curveTokenBalance as bigint, decimals, 4) : "?"} ${symbol} before graduation — click to fill`}
          </button>
        ) : null}
        {exceedsUserTokenBalance ? (
          <button
            type="button"
            onClick={fillMaxSellBalance}
            className="mt-1 text-[0.72rem] text-red-300 underline underline-offset-2 hover:text-red-200"
          >
            Sell amount exceeds your token balance.
          </button>
        ) : null}
        {exceedsCurveEthPool ? (
          <button
            type="button"
            onClick={fillMaxSellPool}
            className="mt-1 text-[0.72rem] text-red-300 underline underline-offset-2 hover:text-red-200"
          >
            Sell amount exceeds ETH available in curve pool.
          </button>
        ) : null}
      </div>

      <dl className="mt-3 space-y-1.5 rounded-lg border border-border/60 bg-canvas/30 px-2.5 py-2.5 text-[0.76rem]">
        {side === "buy" ? (
          <>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">You spend</dt>
              <dd className="font-mono text-fg">
                {ethInWei !== null ? `${formatAmount(ethInWei, 18, 6)} ETH` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">You receive (est.)</dt>
              <dd className="font-mono text-fg">
                {tokensOutEst !== null ? `${formatAmount(tokensOutEst, decimals, 6)} ${symbol}` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Fee (est.)</dt>
              <dd className="font-mono text-team">
                {buyFeeEst !== null ? formatEthFeeEst(buyFeeEst as bigint) : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Min. receive</dt>
              <dd className="font-mono text-emerald-200/90">
                {minTokensBuy !== null ? `${formatAmount(minTokensBuy, decimals, 6)} ${symbol}` : "—"}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">You receive (est.)</dt>
              <dd className="font-mono text-fg">
                {ethOutEst !== null ? `${formatAmount(ethOutEst, 18, 4)} ETH` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Fee (est.)</dt>
              <dd className="font-mono text-team">
                {sellFeeEst !== null ? `${formatAmount(sellFeeEst, 18, 4)} ETH` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Min. receive</dt>
              <dd className="font-mono text-emerald-200/90">
                {minEthSell !== null ? `${formatAmount(minEthSell, 18, 4)} ETH` : "—"}
              </dd>
            </div>
          </>
        )}
      </dl>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-900/40 bg-red-950/25 px-3 py-2 text-[0.75rem] text-red-200">
          {error}
        </p>
      ) : null}
      {successMsg ? (
        <p className="mt-3 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-[0.75rem] font-medium text-emerald-300">
          {successMsg}
        </p>
      ) : null}

      <button
        type="button"
        disabled={
          busy ||
          !isConnected ||
          exceedsUserEthBalance ||
          exceedsCurveTokenPool ||
          exceedsUserTokenBalance ||
          exceedsCurveEthPool
        }
        onClick={() => void (side === "buy" ? onBuy() : onSell())}
        className={`mt-3 w-full rounded-full py-2.5 text-[0.8125rem] font-semibold text-fg shadow-sm transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${
          side === "sell"
            ? "bg-gradient-to-r from-red-600 to-red-500"
            : "bg-gradient-to-r from-accent to-accent-muted"
        }`}
      >
        {!isConnected ? "Connect wallet" : busy ? "Confirm in wallet…" : side === "buy" ? "Buy" : "Sell"}
      </button>
    </div>
  );
}

