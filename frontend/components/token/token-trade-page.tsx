"use client";

import { useQuery } from "@tanstack/react-query";
import { Copy, Globe, TelegramLogo, XLogo } from "@phosphor-icons/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatEther, isAddress, isAddressEqual, zeroAddress, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import {
  bondingCurveReadAbi,
  erc20NameSymbolAbi,
  hypaTokenUriAbi,
  uniswapV2PairAbi,
} from "../../lib/abis/home-reads";
import { deployments } from "../../lib/deployments";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";
import { TOKEN_FACTORY_ADDRESS, tokenFactoryAbi } from "../../lib/token-factory";
import { CoingeckoEthChart } from "../charts/coingecko-eth-chart";
import { CurveTradePanel } from "./curve-trade-panel";
import { PredictionsPanel } from "./predictions-panel";

type LaunchTuple = readonly [
  Address, // token
  Address, // bondingCurve
  Address, // devVesting
  Address, // pool
  Address, // dev
  bigint,  // launchedAt
  boolean, // graduated
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

function formatMcUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0.00";
}

export function TokenTradePage({ address }: { address: string }) {
  const deployChainId = deployments.chainId;
  const weth = deployments.contracts.WETH9 as Address;

  if (!isAddress(address)) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/80 p-8 text-center">
        <p className="text-team">Invalid address.</p>
        <Link href="/" className="mt-4 inline-block text-accent underline">
          Back to markets
        </Link>
      </div>
    );
  }

  const token = address as Address;

  const { data: launch, isPending: launchPending } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "launches",
    args: [token],
    chainId: deployChainId,
  });

  const { data: name } = useReadContract({
    address: token,
    abi: erc20NameSymbolAbi,
    functionName: "name",
    chainId: deployChainId,
  });

  const { data: symbol } = useReadContract({
    address: token,
    abi: erc20NameSymbolAbi,
    functionName: "symbol",
    chainId: deployChainId,
  });

  const { data: tokenUri } = useReadContract({
    address: token,
    abi: hypaTokenUriAbi,
    functionName: "tokenURI",
    chainId: deployChainId,
  });

  const { data: meta } = useQuery({
    queryKey: ["hypa-token-meta", tokenUri],
    enabled: typeof tokenUri === "string" && tokenUri.trim().length > 0,
    queryFn: () => fetchHypaTokenMetadata(tokenUri as string),
    staleTime: 60 * 60 * 1000,
  });

  const { data: ethUsd } = useQuery({
    queryKey: ["eth-usd"],
    queryFn: async () => {
      const r = await fetch("/api/eth-usd");
      const d = (await r.json()) as { usd?: number; error?: string };
      if (!r.ok) throw new Error(d.error ?? "eth-usd failed");
      if (typeof d.usd !== "number" || !Number.isFinite(d.usd)) throw new Error("bad usd");
      return d.usd;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const tuple = launch && Array.isArray(launch) ? (launch as unknown as LaunchTuple) : null;
  const curve = tuple?.[1];
  const pool = tuple?.[3];
  const dev = tuple?.[4];
  const launchedAt = tuple?.[5];
  const graduatedFactory = tuple?.[6] ?? false;
  const hasCurve = curve !== undefined && curve !== zeroAddress;

  const { data: raisedWei } = useReadContract({
    address: curve ?? zeroAddress,
    abi: bondingCurveReadAbi,
    functionName: "realEthReserve",
    chainId: deployChainId,
    query: { enabled: hasCurve && !graduatedFactory },
  });

  const { data: gradTarget } = useReadContract({
    address: curve ?? zeroAddress,
    abi: bondingCurveReadAbi,
    functionName: "GRADUATION_ETH_TARGET",
    chainId: deployChainId,
    query: { enabled: hasCurve && !graduatedFactory },
  });

  // Treat as graduated if the factory says so OR if the curve's ETH reserve
  // has already hit the target (factory flag may lag a block or two).
  const graduated =
    graduatedFactory ||
    (raisedWei !== undefined &&
      gradTarget !== undefined &&
      (raisedWei as bigint) >= (gradTarget as bigint));

  const hasPool = graduated && pool !== undefined && pool !== zeroAddress;

  const poolContracts = useMemo(
    () =>
      hasPool
        ? [
            { chainId: deployChainId, address: pool!, abi: uniswapV2PairAbi, functionName: "getReserves" as const },
            { chainId: deployChainId, address: pool!, abi: uniswapV2PairAbi, functionName: "token0" as const },
            { chainId: deployChainId, address: pool!, abi: uniswapV2PairAbi, functionName: "token1" as const },
          ]
        : [],
    [hasPool, pool, deployChainId],
  );

  const { data: poolData } = useReadContracts({
    contracts: poolContracts,
    query: { enabled: poolContracts.length > 0 },
  });

  const poolEthWei = useMemo(() => {
    if (!poolData || poolData.length < 3) return null;
    const [resR, t0R, t1R] = poolData;
    if (resR?.status !== "success" || t0R?.status !== "success" || t1R?.status !== "success") return null;
    const [reserve0, reserve1] = resR.result as readonly [bigint, bigint, number];
    const t0 = t0R.result as Address;
    const t1 = t1R.result as Address;
    if (isAddressEqual(t0, weth)) return reserve0;
    if (isAddressEqual(t1, weth)) return reserve1;
    return null;
  }, [poolData, weth]);

  const mcUsd = useMemo(() => {
    if (ethUsd === undefined || !Number.isFinite(ethUsd)) return null;
    if (!graduated && raisedWei !== undefined) {
      return Number(formatEther(raisedWei as bigint)) * ethUsd;
    }
    if (graduated && poolEthWei !== null && poolEthWei !== undefined) {
      return Number(formatEther(poolEthWei)) * 2 * ethUsd;
    }
    return null;
  }, [ethUsd, graduated, raisedWei, poolEthWei]);

  const progress = useMemo(() => {
    if (graduated) return 100;
    if (!raisedWei || !gradTarget || (gradTarget as bigint) <= BigInt(0)) return 0;
    const pct = Number((raisedWei as bigint) * BigInt(10000) / (gradTarget as bigint)) / 100;
    return Math.min(100, pct);
  }, [graduated, raisedWei, gradTarget]);

  const titleName = meta?.metaName?.trim() || (typeof name === "string" && name.trim() ? name : "Token");
  const titleSym = typeof symbol === "string" && symbol.trim() ? symbol : "???";
  const description = meta?.description?.trim();

  const [copied, setCopied] = useState(false);
  const [creatorCopied, setCreatorCopied] = useState(false);
  const [activePanel, setActivePanel] = useState<"chart" | "predictions">("chart");

  const shortDev = useMemo(
    () => (dev ? `${dev.slice(0, 6)}...${dev.slice(-4)}` : null),
    [dev],
  );

  return (
    <div>
      <div className="relative mb-5 overflow-hidden rounded-xl bg-gradient-to-b from-emerald-950/16 via-black/28 to-transparent">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_0%_0%,rgba(16,185,129,0.12),transparent_58%)]" />
        <div className="relative grid grid-cols-[96px_1fr] gap-0">
          {/* left: image */}
          <div className="relative min-h-24 w-24 self-stretch bg-transparent">
            {meta?.imageCandidates?.[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.imageCandidates[0]} alt="" className="absolute inset-0 h-full w-full bg-transparent p-1.5 object-contain" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.04] to-transparent font-heading text-2xl text-accent">
                {titleSym.slice(0, 2)}
              </div>
            )}
          </div>

          {/* right: info */}
          <div className="flex flex-col gap-2 p-3">
            {/* row 1: name + ticker + socials */}
            <div className="flex items-center gap-2 overflow-hidden">
              <h1 className="truncate font-heading text-lg font-semibold tracking-tight text-fg">
                {titleName}
              </h1>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(token);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                }}
                className="inline-flex shrink-0 items-center gap-1 text-[0.9rem] font-semibold text-accent"
                title="Copy token contract address"
              >
                ${titleSym}
                <Copy size={13} />
                {copied ? <span className="text-[0.65rem] text-team">Copied</span> : null}
              </button>
              <div className="ml-auto flex shrink-0 items-center gap-0.5 text-team">
                {meta?.twitter ? (
                  <a href={meta.twitter} target="_blank" rel="noreferrer" className="rounded-md p-1 hover:bg-surface-hover hover:text-fg">
                    <XLogo size={15} />
                  </a>
                ) : null}
                {meta?.telegram ? (
                  <a href={meta.telegram} target="_blank" rel="noreferrer" className="rounded-md p-1 hover:bg-surface-hover hover:text-fg">
                    <TelegramLogo size={15} />
                  </a>
                ) : null}
                {meta?.website ? (
                  <a href={meta.website} target="_blank" rel="noreferrer" className="rounded-md p-1 hover:bg-surface-hover hover:text-fg">
                    <Globe size={15} />
                  </a>
                ) : null}
              </div>
            </div>

            {/* row 2: MC */}
            <p className="font-mono text-base font-semibold tabular-nums leading-none text-emerald-200">
              {mcUsd !== null ? `${formatMcUsd(mcUsd)} mc` : <span className="text-team text-[0.8rem]">…</span>}
            </p>

            {description ? (
              <p className="line-clamp-2 text-[0.75rem] leading-snug text-team">{description}</p>
            ) : null}

            {/* row 3: status + date + creator */}
            <div className="flex flex-wrap items-center gap-1.5 text-[0.7rem] text-team">
              <span
                className={`rounded-full px-1.5 py-0.5 font-medium ${graduated ? "bg-emerald-900/45 text-emerald-200" : "bg-amber-900/40 text-amber-200"}`}
              >
                {graduated ? "Graduated" : `Bonding curve ${progress.toFixed(1)}%${
                  raisedWei !== undefined && gradTarget !== undefined
                    ? (() => { const left = (gradTarget as bigint) - (raisedWei as bigint); return ` (${Number(formatEther(left > BigInt(0) ? left : BigInt(0))).toFixed(4)} ETH left)`; })()
                    : ""
                }`}
              </span>
              {launchedAt ? (
                <span>
                  {new Date(Number(launchedAt) * 1000).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              ) : null}
              {shortDev ? (
                <button
                  type="button"
                  onClick={() => {
                    if (!dev) return;
                    void navigator.clipboard.writeText(dev);
                    setCreatorCopied(true);
                    window.setTimeout(() => setCreatorCopied(false), 1500);
                  }}
                  title={dev ?? undefined}
                  className="rounded-md px-1 py-0.5 font-medium text-team hover:bg-surface-hover hover:text-fg"
                >
                  Creator: {shortDev} {creatorCopied ? "Copied" : ""}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {launchPending ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <div
            className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-accent"
            aria-label="Loading token page"
          />
        </div>
      ) : !hasCurve ? (
        <div className="rounded-xl border border-border bg-surface-elevated/80 p-8 text-center text-[0.875rem] text-team">
          This address is not a Hypapad token from the factory on chain {deployChainId}, or launch
          data is empty.
          <Link href="/" className="mt-4 block text-accent underline">
            Back to markets
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-4">
          <div className="min-w-0 lg:col-span-8">
            <div className="mb-3 flex gap-2">
              <button
                type="button"
                onClick={() => setActivePanel("chart")}
                className={`rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition-colors ${activePanel === "chart" ? "bg-accent text-fg" : "text-team hover:text-fg"}`}
              >
                Chart
              </button>
              <button
                type="button"
                onClick={() => setActivePanel("predictions")}
                className={`rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition-colors ${activePanel === "predictions" ? "bg-accent text-fg" : "text-team hover:text-fg"}`}
              >
                Predictions
              </button>
            </div>
            {activePanel === "chart" ? (
              <CoingeckoEthChart />
            ) : (
              <PredictionsPanel
                tokenAddress={token}
                tokenSymbol={titleSym}
                tokenImage={meta?.imageCandidates?.[0]}
                ethUsd={ethUsd}
              />
            )}
          </div>
          <div className="min-w-0 lg:col-span-4">
            <div className="lg:sticky lg:top-20 lg:ml-auto lg:w-full">
              <CurveTradePanel
                tokenAddress={token}
                curveAddress={curve}
                symbol={titleSym}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

