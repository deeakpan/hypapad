"use client";

import { useCallback, useMemo, useState } from "react";
import { type Address, formatEther, parseEther } from "viem";
import {
  useAccount,
  useBalance,
  useConfig,
  useReadContract,
  useWriteContract,
} from "wagmi";
import { waitForTransactionReceipt } from "viem/actions";
import { getPublicClient } from "@wagmi/core";
import type { Config } from "@wagmi/core";
import { predictionMarketAbi } from "../../lib/abis/prediction-market";
import { deployments, PREDICTION_MARKET_ADDRESS } from "../../lib/deployments";
import { useQueryClient } from "@tanstack/react-query";

const MARKET_TYPE_LABELS: Record<number, string> = {
  2: "ETH Target",
  3: "Price Multiplier",
  4: "Mcap Multiplier",
  5: "Mcap Range",
  6: "Price Multiplier",
  7: "Liquidity",
  8: "Custom",
};

function displayTicker(raw: string): string {
  const s = raw.trim();
  if (!s) return "$???";
  return s.startsWith("$") ? s : `$${s}`;
}

const STATUS: Record<number, string> = { 0: "Open", 1: "Resolved", 2: "Cancelled" };

type MarketData = {
  token: Address;
  curve: Address;
  pool: Address;
  marketType: number;
  status: number;
  deadline: bigint;
  ethTarget: bigint;
  multiplierX10: bigint;
  strikePrice: bigint;
  graduationMcap: bigint;
  graduationPrice: bigint;
  minLiquidity: bigint;
  cumulativeAtStart: bigint;
  timestampAtStart: bigint;
  winningBucket: number;
  description: string;
  outcome: boolean;
  resolutionTime: bigint;
};

function fmt(wei: bigint, dec = 4): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  const t = f.replace(/0+$/, "").slice(0, dec);
  return t ? `${i}.${t}` : i;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function toShortStakeError(error: unknown): string {
  if (!(error instanceof Error)) return "Stake failed.";
  const msg = error.message || "";
  const lower = msg.toLowerCase();

  if (
    lower.includes("user rejected") ||
    lower.includes("user denied") ||
    lower.includes("denied transaction signature")
  ) {
    return "Transaction rejected.";
  }

  if (lower.includes("insufficient funds")) {
    return "Insufficient funds for this transaction.";
  }

  return "Stake failed. Please try again.";
}

async function waitTx(config: Config, chainId: number, hash: `0x${string}`) {
  const pc = getPublicClient(config, { chainId });
  if (!pc) throw new Error("no public client");
  await waitForTransactionReceipt(pc, { hash });
}

function marketQuestion(m: MarketData, tokenSymbol: string): string {
  if (m.description) return m.description;
  const tick = displayTicker(tokenSymbol);
  const base = MARKET_TYPE_LABELS[m.marketType] ?? "Unknown market";
  if (m.marketType === 0) return `Will ${tick} graduate within 24h?`;
  if (m.marketType === 1) return `Will ${tick} graduate within 72h?`;
  if (m.marketType === 3 || m.marketType === 6)
    return `Will price reach ${Number(m.multiplierX10) / 10}× before deadline?`;
  if (m.marketType === 2)
    return `Will ETH raised hit ${fmt(m.ethTarget)} ETH before deadline?`;
  if (m.marketType === 4)
    return `Will mcap reach ${Number(m.multiplierX10) / 10}× before deadline?`;
  if (m.marketType === 7)
    return `Will pool keep >${fmt(m.minLiquidity)} ETH liquidity?`;
  return base;
}

export function MarketCard({
  marketId,
  pmAddress,
  chainId,
  userAddress,
  tokenSymbol,
  tokenImage,
  ethUsd,
  align = "center",
  gridCell = false,
  hideTrade = false,
  rangePositionText,
  stakesFooter,
}: {
  marketId: bigint;
  pmAddress: Address;
  chainId: number;
  userAddress?: Address;
  tokenSymbol: string;
  tokenImage?: string;
  ethUsd?: number;
  /** `center`: max-width card centered. `left`: max-width card flush left. */
  align?: "center" | "left";
  /** When true, card fills a grid cell (no max-width / no horizontal centering). */
  gridCell?: boolean;
  /** Hide YES/NO stake controls (e.g. stakes portfolio page). */
  hideTrade?: boolean;
  /** Extra line for range (mcap) stakes when binary stakes are zero. */
  rangePositionText?: string | null;
  /** Claim / refund actions for resolved or cancelled markets. */
  stakesFooter?: {
    statusNote?: string;
    claimLabel?: string;
    onClaim?: () => void | Promise<void>;
    claimBusy?: boolean;
    refundLabel?: string;
    onRefund?: () => void | Promise<void>;
    refundBusy?: boolean;
  } | null;
}) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [stakeAmt, setStakeAmt] = useState("");
  const [stakeErr, setStakeErr] = useState<string | null>(null);
  const [stakeOk, setStakeOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedSide, setSelectedSide] = useState<boolean | null>(null);

  const { data: walletBalance } = useBalance({
    address: userAddress,
    chainId,
    query: { enabled: Boolean(userAddress) && !hideTrade },
  });

  const { data: marketRaw } = useReadContract({
    address: pmAddress,
    abi: predictionMarketAbi,
    functionName: "getMarket",
    args: [marketId],
    chainId,
  });

  const { data: yesPoolRaw } = useReadContract({
    address: pmAddress,
    abi: predictionMarketAbi,
    functionName: "yesPool",
    args: [marketId],
    chainId,
  });

  const { data: noPoolRaw } = useReadContract({
    address: pmAddress,
    abi: predictionMarketAbi,
    functionName: "noPool",
    args: [marketId],
    chainId,
  });

  const { data: userStakesRaw } = useReadContract({
    address: pmAddress,
    abi: predictionMarketAbi,
    functionName: "getUserStakes",
    args: userAddress ? [marketId, userAddress] : undefined,
    chainId,
    query: { enabled: Boolean(userAddress) },
  });

  // useMemo must always run — no early returns before it
  const m = useMemo(() => marketRaw as MarketData | undefined, [marketRaw]);
  const question = useMemo(() => (m ? marketQuestion(m, tokenSymbol) : ""), [m, tokenSymbol]);
  const walletWei = walletBalance?.value ?? BigInt(0);

  const doStake = useCallback(async (side: boolean) => {
    setStakeErr(null);
    setStakeOk(null);
    const t = stakeAmt.trim();
    if (!t || isNaN(Number(t)) || Number(t) <= 0) {
      setStakeErr("Enter an ETH amount.");
      return;
    }
    if (!userAddress) {
      setStakeErr("Connect your wallet.");
      return;
    }
    let value: bigint;
    try { value = parseEther(t); } catch { setStakeErr("Invalid amount."); return; }
    if (value > walletWei) {
      setStakeErr("Amount exceeds your wallet balance.");
      return;
    }
    setBusy(true);
    try {
      const hash = await writeContractAsync({
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "stake",
        args: [marketId, side],
        value,
        chainId,
      });
      await waitTx(config, chainId, hash);
      setStakeAmt("");
      setStakeOk(`Staked ${t} ETH on ${side ? "YES" : "NO"}`);
      await queryClient.invalidateQueries();
    } catch (e) {
      setStakeErr(toShortStakeError(e));
    } finally {
      setBusy(false);
    }
  }, [stakeAmt, userAddress, marketId, pmAddress, chainId, config, writeContractAsync, queryClient, walletWei]);

  const widthClasses = gridCell
    ? "w-full min-w-0"
    : `w-full md:max-w-[560px] ${align === "left" ? "" : "md:mx-auto"}`;

  if (!m) {
    return (
      <div
        className={`h-36 animate-pulse rounded-xl border border-border bg-surface-elevated/50 ${widthClasses}`}
      />
    );
  }

  const yes = (yesPoolRaw as bigint | undefined) ?? BigInt(0);
  const no  = (noPoolRaw  as bigint | undefined) ?? BigInt(0);
  const tvl = yes + no;
  const tvlUsd = ethUsd !== undefined && Number.isFinite(ethUsd)
    ? Number(formatEther(tvl)) * ethUsd
    : null;
  const yesPct = tvl > BigInt(0) ? Number((yes * BigInt(10000)) / tvl) / 100 : 50;
  const noPct = 100 - yesPct;

  const userStakes = userStakesRaw as readonly [bigint, bigint] | undefined;
  const userYes = userStakes?.[0] ?? BigInt(0);
  const userNo  = userStakes?.[1] ?? BigInt(0);

  const deadline = Number(m.deadline);
  const isExpired = deadline > 0 && Date.now() / 1000 > deadline;
  const isOpen = m.status === 0 && !isExpired;
  const statusLabel = m.status === 0 ? (isExpired ? "Pending resolution" : "Open") : STATUS[m.status] ?? "Unknown";
  const exactDeadline = deadline > 0
    ? new Date(deadline * 1000).toLocaleString(undefined, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : null;

  return (
    <div
      className={`${widthClasses} flex min-h-[11.5rem] flex-col rounded-2xl border border-border/80 bg-gradient-to-b from-surface-elevated to-surface-elevated/80 p-5 shadow-[0_10px_35px_-20px_rgba(0,0,0,0.8)] transition-[border-color,box-shadow,transform] duration-200 group-hover:border-accent/45 group-hover:shadow-[0_16px_40px_-22px_rgba(0,0,0,0.9)] group-hover:-translate-y-0.5 sm:p-6`}
    >
      {/* Header */}
      <div className="shrink-0 flex items-start gap-3">
        <div className="relative mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-border bg-canvas">
          {tokenImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tokenImage} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-hover to-canvas font-heading text-[0.6rem] font-bold text-accent">
              {tokenSymbol.slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[0.82rem] font-semibold leading-snug text-fg transition-colors group-hover:text-accent group-hover:underline group-hover:decoration-accent/80 group-hover:underline-offset-3">{question}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-full px-1.5 py-0.5 text-[0.63rem] font-medium ${
                m.status === 0
                  ? isExpired
                    ? "bg-amber-900/40 text-amber-200"
                    : "bg-accent/20 text-accent"
                  : m.status === 1
                    ? "bg-emerald-900/40 text-emerald-200"
                    : "bg-surface-hover text-team"
              }`}
            >
              {statusLabel}
            </span>
            <span className="text-[0.63rem] text-muted">#{marketId.toString()}</span>
            {exactDeadline ? <span className="text-[0.63rem] text-muted">Ends: {exactDeadline}</span> : null}
          </div>
        </div>
      </div>

      <p className="mt-3 shrink-0 text-[0.7rem] text-muted">
        TVL: <span className="font-mono font-semibold text-fg">{fmt(tvl, 6)} ETH</span>
        {tvlUsd !== null ? <span> ({fmtUsd(tvlUsd)})</span> : null}
      </p>

      {/* Resolved outcome */}
      {m.status === 1 ? (
        <div className={`mt-2.5 shrink-0 rounded-lg px-2.5 py-1.5 text-[0.75rem] font-semibold ${m.outcome ? "bg-emerald-900/35 text-emerald-200" : "bg-red-900/30 text-red-200"}`}>
          Resolved: {m.outcome ? "YES" : "NO"}
        </div>
      ) : null}

      {/* User existing stakes */}
      {(userYes > BigInt(0) || userNo > BigInt(0) || rangePositionText) ? (
        <div className="mt-2.5 shrink-0 rounded-lg border border-border/60 bg-canvas/40 px-2.5 py-1.5 text-[0.72rem]">
          Your position:{" "}
          {userYes > BigInt(0) ? <span className="text-emerald-300 font-medium">Yes {fmt(userYes, 6)} ETH</span> : null}
          {userYes > BigInt(0) && userNo > BigInt(0) ? " · " : null}
          {userNo > BigInt(0) ? <span className="text-red-300 font-medium">No {fmt(userNo, 6)} ETH</span> : null}
          {rangePositionText ? (
            <span className="block pt-1 text-team">{rangePositionText}</span>
          ) : null}
        </div>
      ) : null}

      {/* Trade area — expandable when open */}
      {isOpen && !hideTrade ? (
        <div className="mt-auto flex min-h-0 flex-col space-y-2 pt-5 sm:pt-6">
          <div className="grid grid-cols-2 gap-2 sm:gap-2.5">
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setStakeErr(null);
                setStakeOk(null);
                if (!isExpanded) {
                  setSelectedSide(false);
                  setIsExpanded(true);
                  return;
                }
                setSelectedSide(false);
                void doStake(false);
              }}
              className={`relative min-h-[2.35rem] cursor-pointer rounded-xl px-2 py-2 text-[0.78rem] font-semibold text-white transition-[filter,transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:scale-[1.02] hover:brightness-110 hover:shadow-[0_10px_28px_-6px_rgba(220,38,38,0.45)] active:translate-y-0 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 disabled:pointer-events-none disabled:opacity-40 sm:min-h-[2.5rem] sm:text-[0.8rem] ${
                selectedSide === false
                  ? "bg-gradient-to-r from-red-500 to-red-400 ring-1 ring-red-300/70"
                  : "bg-gradient-to-r from-red-600 to-red-500"
              }`}
            >
              {busy && selectedSide === false ? "…" : `NO ${noPct.toFixed(1)}%`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setStakeErr(null);
                setStakeOk(null);
                if (!isExpanded) {
                  setSelectedSide(true);
                  setIsExpanded(true);
                  return;
                }
                setSelectedSide(true);
                void doStake(true);
              }}
              className={`relative min-h-[2.35rem] cursor-pointer rounded-xl px-2 py-2 text-[0.78rem] font-semibold text-white transition-[filter,transform,box-shadow] duration-200 ease-out hover:-translate-y-px hover:scale-[1.02] hover:brightness-110 hover:shadow-[0_10px_28px_-6px_rgba(16,185,129,0.4)] active:translate-y-0 active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/40 disabled:pointer-events-none disabled:opacity-40 sm:min-h-[2.5rem] sm:text-[0.8rem] ${
                selectedSide === true
                  ? "bg-gradient-to-r from-emerald-500 to-emerald-400 ring-1 ring-emerald-300/70"
                  : "bg-gradient-to-r from-emerald-600 to-emerald-500"
              }`}
            >
              {busy && selectedSide === true ? "…" : `YES ${yesPct.toFixed(1)}%`}
            </button>
          </div>
          {isExpanded ? (
            <>
              <div className="flex items-center justify-between text-[0.68rem]">
                <span className="text-muted">Available balance</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setStakeAmt(formatEther(walletWei)); setStakeErr(null); setStakeOk(null);
                  }}
                  className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[0.62rem] text-team transition-colors hover:border-accent hover:text-accent"
                >
                  MAX {fmt(walletWei, 6)} ETH
                </button>
              </div>
              <input
                value={stakeAmt}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); setStakeAmt(e.target.value); setStakeErr(null); setStakeOk(null); }}
                inputMode="decimal"
                placeholder="0.0 ETH"
                className="w-full rounded-lg border border-border bg-canvas px-2.5 py-1.5 font-mono text-[0.8rem] text-fg outline-none focus:border-accent"
              />
            </>
          ) : null}
          {stakeErr ? (
            <p className="rounded-lg border border-red-900/40 bg-red-950/25 px-2.5 py-1.5 text-[0.72rem] text-red-200">{stakeErr}</p>
          ) : null}
          {stakeOk ? (
            <p className="rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-2.5 py-1.5 text-[0.72rem] font-medium text-emerald-300">{stakeOk}</p>
          ) : null}
        </div>
      ) : null}

      {hideTrade && stakesFooter ? (
        <div className="mt-auto space-y-2 pt-4 sm:pt-5">
          {stakesFooter.statusNote ? (
            <p className="text-[0.72rem] leading-snug text-muted">{stakesFooter.statusNote}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {stakesFooter.claimLabel && stakesFooter.onClaim ? (
              <button
                type="button"
                disabled={stakesFooter.claimBusy}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void stakesFooter.onClaim?.();
                }}
                className="rounded-xl bg-gradient-to-r from-accent to-accent-muted px-4 py-2 text-[0.78rem] font-semibold text-fg shadow-sm transition-[filter] hover:brightness-110 disabled:opacity-40"
              >
                {stakesFooter.claimBusy ? "…" : stakesFooter.claimLabel}
              </button>
            ) : null}
            {stakesFooter.refundLabel && stakesFooter.onRefund ? (
              <button
                type="button"
                disabled={stakesFooter.refundBusy}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void stakesFooter.onRefund?.();
                }}
                className="rounded-xl border border-border bg-surface-hover px-4 py-2 text-[0.78rem] font-semibold text-fg transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {stakesFooter.refundBusy ? "…" : stakesFooter.refundLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PredictionsPanel({
  tokenAddress,
  tokenSymbol,
  tokenImage,
  ethUsd,
}: {
  tokenAddress: Address;
  tokenSymbol: string;
  tokenImage?: string;
  ethUsd?: number;
}) {
  const chainId = deployments.chainId;
  const pmAddress = PREDICTION_MARKET_ADDRESS;
  const { address: userAddress } = useAccount();

  const { data: marketIds, isPending } = useReadContract({
    address: pmAddress,
    abi: predictionMarketAbi,
    functionName: "getTokenMarkets",
    args: [tokenAddress],
    chainId,
  });

  const ids = (marketIds as bigint[] | undefined) ?? [];

  if (isPending) {
    return (
      <div className="flex min-h-[28vh] items-center justify-center">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-accent"
          aria-label="Loading token predictions"
        />
      </div>
    );
  }

  if (ids.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/80 p-6 text-center text-[0.875rem] text-team">
        No prediction markets for this token yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {ids.map((id) => (
        <OpenMarketCard
          key={id.toString()}
          marketId={id}
          pmAddress={pmAddress}
          chainId={chainId}
          userAddress={userAddress}
          tokenSymbol={tokenSymbol}
          tokenImage={tokenImage}
          ethUsd={ethUsd}
        />
      ))}
    </div>
  );
}

function OpenMarketCard(props: {
  marketId: bigint;
  pmAddress: Address;
  chainId: number;
  userAddress?: Address;
  tokenSymbol: string;
  tokenImage?: string;
  ethUsd?: number;
}) {
  const { data: marketRaw } = useReadContract({
    address: props.pmAddress,
    abi: predictionMarketAbi,
    functionName: "getMarket",
    args: [props.marketId],
    chainId: props.chainId,
  });

  const m = marketRaw as MarketData | undefined;

  // Hide resolved or cancelled markets
  if (m && m.status !== 0) return null;

  return <MarketCard {...props} />;
}
