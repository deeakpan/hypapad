"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, FireSimple, SwimmingPool } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  type Address,
  formatEther,
  isAddress,
  isAddressEqual,
  zeroAddress,
} from "viem";
import { useChainId, useReadContract, useReadContracts, useWatchBlockNumber } from "wagmi";
import {
  bondingCurveReadAbi,
  erc20NameSymbolAbi,
  hypaTokenUriAbi,
  uniswapV2PairAbi,
} from "../../lib/abis/home-reads";
import { deployments } from "../../lib/deployments";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";
import { TOKEN_FACTORY_ADDRESS, tokenFactoryAbi } from "../../lib/token-factory";

type LaunchRow = {
  token: Address;
  bondingCurve: Address;
  devVesting: Address;
  pool: Address;
  dev: Address;
  launchedAt: bigint;
  graduated: boolean;
  gradMarketBitmask: number;
  gradMcapMultX10: bigint;
  gradMcapMultDays: bigint;
  gradPriceMultX10: bigint;
  gradPriceMultDays: bigint;
  gradMinLiquidity: bigint;
  gradLiquidityDays: bigint;
};

type LaunchTuple = readonly [
  Address, // token
  Address, // bondingCurve
  Address, // devVesting
  Address, // pool
  Address, // dev
  bigint, // launchedAt
  boolean, // graduated
  number, // gradMarketBitmask
  bigint, // gradMcapMultX10
  bigint, // gradMcapMultDays
  bigint, // gradPriceMultX10
  bigint, // gradPriceMultDays
  bigint, // gradMinLiquidity
  bigint, // gradLiquidityDays
];

function formatEthCompact(wei: bigint, maxDecimals = 4): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  if (!f) return i;
  const trimmed = f.replace(/0+$/, "");
  if (!trimmed) return i;
  return `${i}.${trimmed.slice(0, maxDecimals)}`;
}

/** One-line MC / raised USD (no decimals noise for small amounts). */
function formatMcUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return "$0.00";
}

function pctOnCurve(raised: bigint, target: bigint): number {
  if (target <= BigInt(0)) return 0;
  const x = (raised * BigInt(10000)) / target;
  return Math.min(100, Number(x) / 100);
}

function leftOnCurve(raised: bigint, target: bigint): bigint {
  if (target <= BigInt(0)) return BigInt(0);
  return raised >= target ? BigInt(0) : target - raised;
}

/** Full-bleed top banner: parent must be `relative` with width + aspect (or fixed height). */
function TokenMedia({
  imageCandidates,
  symbol,
  isLoading,
}: {
  imageCandidates: string[];
  symbol: string;
  isLoading: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [broken, setBroken] = useState(false);

  const src = !broken && imageCandidates.length > 0 ? imageCandidates[Math.min(idx, imageCandidates.length - 1)] : null;

  if (isLoading && !src) {
    return (
      <div className="absolute inset-0 animate-pulse bg-surface-hover" aria-hidden />
    );
  }

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="absolute inset-0 h-full w-full bg-canvas p-1.5 object-contain"
        onError={() => {
          if (idx + 1 < imageCandidates.length) {
            setIdx((i) => i + 1);
          } else {
            setBroken(true);
          }
        }}
      />
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-hover to-canvas font-heading text-2xl font-bold text-accent/90 sm:text-3xl">
      {broken || !imageCandidates.length ? (symbol.slice(0, 2).toUpperCase() || "?") : null}
    </div>
  );
}

function TokenCard({
  token,
  name,
  symbol,
  launch,
  raisedWei,
  gradTargetWei,
  curveGraduated,
  poolEthReserve,
  ethUsd,
  ethUsdLoading,
  imageCandidates,
  metaLoading,
  metaName,
  isHot,
}: {
  token: Address;
  name: string;
  symbol: string;
  launch: LaunchRow;
  raisedWei: bigint;
  gradTargetWei: bigint;
  curveGraduated: boolean;
  poolEthReserve: bigint | null;
  ethUsd: number | null;
  ethUsdLoading: boolean;
  imageCandidates: string[];
  metaLoading: boolean;
  metaName?: string;
  isHot: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const displayName = (metaName?.trim() || name.trim() || "Unknown token").slice(0, 80);

  const copyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [token]);

  const launchedDate = useMemo(() => {
    const s = Number(launch.launchedAt);
    if (!Number.isFinite(s) || s <= 0) return null;
    return new Date(s * 1000);
  }, [launch.launchedAt]);

  const onCurve = !curveGraduated;
  const progress = onCurve ? pctOnCurve(raisedWei, gradTargetWei) : 100;
  const leftWei = leftOnCurve(raisedWei, gradTargetWei);
  const bondingPct = `${progress.toFixed(1)}%`;

  const raisedEth = Number(formatEther(raisedWei));
  const poolEthNum =
    poolEthReserve !== null && poolEthReserve > BigInt(0)
      ? Number(formatEther(poolEthReserve))
      : null;

  const usdMain =
    ethUsd !== null && Number.isFinite(ethUsd)
      ? onCurve
        ? raisedEth * ethUsd
        : poolEthNum !== null
          ? poolEthNum * 2 * ethUsd
          : null
      : null;

  const mcPending =
    ethUsdLoading ||
    (!onCurve && poolEthNum === null && launch.pool !== zeroAddress);

  const mcLine = mcPending
    ? null
    : usdMain !== null && Number.isFinite(usdMain)
      ? `${formatMcUsd(usdMain)} mc`
      : "—";

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface-elevated/90 shadow-sm backdrop-blur-sm transition-[border-color,box-shadow,transform] duration-200 group-hover:border-accent/45 group-hover:shadow-[0_14px_40px_rgba(0,0,0,0.35)]">
      <div className="relative aspect-[2/1] w-full shrink-0 border-b border-border bg-canvas">
        <TokenMedia
          imageCandidates={imageCandidates}
          symbol={symbol}
          isLoading={metaLoading}
        />
        {isHot ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-orange-500/90 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide text-white shadow-sm">
            <FireSimple size={10} weight="fill" />
            HOT
          </span>
        ) : null}
      </div>

      <div className="flex flex-col p-2 sm:p-3">
        <h2 className="line-clamp-2 font-heading text-[0.82rem] font-semibold leading-tight tracking-tight text-fg sm:text-[0.9375rem]">
          {displayName}
        </h2>
        <button
          type="button"
          aria-label={`Copy contract address for ${symbol || "token"}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copyAddress();
          }}
          className="group/tick mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg py-0.5 text-left text-[0.74rem] font-semibold text-accent outline-none transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-accent/50 sm:text-[0.8125rem]"
          title="Copy token contract address"
        >
          <span className="truncate">
            ${symbol || "???"}
            {copied ? (
              <span className="ml-1.5 text-[0.7rem] font-medium text-team">Copied</span>
            ) : null}
          </span>
          <Copy
            size={15}
            weight="regular"
            className="shrink-0 opacity-60 group-hover/tick:opacity-100"
            aria-hidden
          />
        </button>
        {launchedDate ? (
          <p className="mt-0.5 text-[0.65rem] text-muted">
            {launchedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        ) : null}

        <p className="mt-2 font-mono text-[0.95rem] font-semibold tabular-nums leading-none text-emerald-200 sm:text-lg">
          {mcLine === null ? <span className="text-team">…</span> : mcLine}
        </p>

        <div className="mt-2.5 space-y-1.5 border-t border-border/50 pt-2 text-[0.7rem] leading-snug sm:text-[0.75rem]">
          {onCurve ? (
            <div>
              <div className="flex items-center justify-between gap-2 font-medium uppercase tracking-wide text-muted">
                <span className="shrink-0">Curve</span>
                <span className="min-w-0 truncate font-mono tabular-nums text-team normal-case">
                  {formatEthCompact(leftWei, 4)} ETH left
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-canvas">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent to-accent-muted transition-[width] duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-1 text-[0.68rem] font-medium text-team">
                Bonding progress: <span className="font-mono tabular-nums text-fg">{bondingPct}</span>
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg bg-emerald-950/35 px-2.5 py-2 text-emerald-100/95">
              <SwimmingPool size={18} weight="duotone" className="mt-0.5 shrink-0 text-emerald-400" />
              <div className="min-w-0">
                <p className="text-[0.75rem] font-medium text-emerald-100">Graduated</p>
                {launch.pool !== zeroAddress ? (
                  <p className="mt-0.5 text-[0.6875rem] text-team">
                    Uniswap pool
                    {poolEthReserve !== null ? (
                      <span className="font-mono tabular-nums text-fg/85">
                        {" "}
                        · ~{formatEthCompact(poolEthReserve, 4)} WETH
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="mt-0.5 text-[0.6875rem] text-team">No pool on record</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** Per-token pool ETH reserve (WETH side); null if not applicable or unreadable. */
function usePoolEthReserves(
  rows: { token: Address; pool: Address; graduated: boolean }[],
  weth: Address,
  readChainId: number,
) {
  const poolRowsFiltered = useMemo(
    () => rows.filter((r) => r.graduated && r.pool !== zeroAddress),
    [rows],
  );

  const poolContracts = useMemo(() => {
    const c = [];
    for (const r of poolRowsFiltered) {
      c.push({
        chainId: readChainId,
        address: r.pool,
        abi: uniswapV2PairAbi,
        functionName: "getReserves",
      });
      c.push({
        chainId: readChainId,
        address: r.pool,
        abi: uniswapV2PairAbi,
        functionName: "token0",
      });
      c.push({
        chainId: readChainId,
        address: r.pool,
        abi: uniswapV2PairAbi,
        functionName: "token1",
      });
    }
    return c;
  }, [poolRowsFiltered, readChainId]);

  const { data: poolData } = useReadContracts({
    contracts: poolContracts,
    query: { enabled: poolContracts.length > 0 },
  });

  return useMemo(() => {
    const map = new Map<string, bigint | null>();
    if (!poolData?.length || poolContracts.length === 0) return map;
    let idx = 0;
    for (const r of poolRowsFiltered) {
      const resR = poolData[idx++];
      const t0R = poolData[idx++];
      const t1R = poolData[idx++];
      if (
        resR?.status !== "success" ||
        t0R?.status !== "success" ||
        t1R?.status !== "success"
      ) {
        map.set(r.token.toLowerCase(), null);
        continue;
      }
      const [reserve0, reserve1] = resR.result as readonly [bigint, bigint, number];
      const t0 = t0R.result as Address;
      const t1 = t1R.result as Address;
      let ethSide: bigint | null = null;
      if (isAddressEqual(t0, weth)) ethSide = reserve0;
      else if (isAddressEqual(t1, weth)) ethSide = reserve1;
      map.set(r.token.toLowerCase(), ethSide);
    }
    return map;
  }, [poolData, poolContracts.length, poolRowsFiltered, weth, readChainId]);
}

export function MarketsTokenGrid() {
  const queryClient = useQueryClient();
  const walletChainId = useChainId();
  const deployChainId = deployments.chainId;
  const walletMismatch = walletChainId !== deployChainId;
  const weth = deployments.contracts.WETH9 as Address;

  const { data: ethUsd, isPending: ethUsdLoading } = useQuery({
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

  const { data: totalBn, isPending: totalPending } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "totalLaunched",
    chainId: deployChainId,
    query: {
      refetchInterval: 15_000,
    },
  });

  const total = totalBn !== undefined ? Number(totalBn) : 0;

  const indexContracts = useMemo(() => {
    if (total <= 0) return [];
    return Array.from({ length: total }, (_, i) => ({
      chainId: deployChainId,
      address: TOKEN_FACTORY_ADDRESS,
      abi: tokenFactoryAbi,
      functionName: "allTokens" as const,
      args: [BigInt(i)] as const,
    }));
  }, [total, deployChainId]);

  const { data: allTokenResults, isPending: listPending } = useReadContracts({
    contracts: indexContracts,
    query: { enabled: indexContracts.length > 0, refetchInterval: 10_000 },
  });

  const tokenAddresses = useMemo(() => {
    if (!allTokenResults?.length) return [] as Address[];
    const out: Address[] = [];
    for (const row of allTokenResults) {
      if (row.status !== "success" || !row.result) continue;
      const a = row.result as Address;
      if (isAddress(a)) out.push(a);
    }
    return out.reverse();
  }, [allTokenResults]);

  const detailContracts = useMemo(() => {
    if (tokenAddresses.length === 0) return [];
    const c = [];
    for (const t of tokenAddresses) {
      c.push({
        chainId: deployChainId,
        address: TOKEN_FACTORY_ADDRESS,
        abi: tokenFactoryAbi,
        functionName: "launches" as const,
        args: [t] as const,
      });
      c.push({
        chainId: deployChainId,
        address: t,
        abi: erc20NameSymbolAbi,
        functionName: "name" as const,
      });
      c.push({
        chainId: deployChainId,
        address: t,
        abi: erc20NameSymbolAbi,
        functionName: "symbol" as const,
      });
      c.push({
        chainId: deployChainId,
        address: t,
        abi: hypaTokenUriAbi,
        functionName: "tokenURI" as const,
      });
    }
    return c;
  }, [tokenAddresses, deployChainId]);

  const { data: detailResults, isPending: detailPending } = useReadContracts({
    contracts: detailContracts,
    query: { enabled: detailContracts.length > 0, refetchInterval: 10_000 },
  });

  const parsedRows = useMemo(() => {
    if (!detailResults?.length || tokenAddresses.length === 0) return [];
    const n = tokenAddresses.length;
    const out: {
      token: Address;
      name: string;
      symbol: string;
      tokenURI: string;
      launch: LaunchRow;
      curve: Address;
    }[] = [];
    for (let i = 0; i < n; i++) {
      const base = i * 4;
      const L = detailResults[base];
      const N = detailResults[base + 1];
      const S = detailResults[base + 2];
      const U = detailResults[base + 3];
      if (L?.status !== "success" || !L.result) continue;
      const lt = L.result as unknown as LaunchTuple;
      const lr: LaunchRow = {
        token: lt[0],
        bondingCurve: lt[1],
        devVesting: lt[2],
        pool: lt[3],
        dev: lt[4],
        launchedAt: lt[5],
        graduated: lt[6],
        gradMarketBitmask: lt[7],
        gradMcapMultX10: lt[8],
        gradMcapMultDays: lt[9],
        gradPriceMultX10: lt[10],
        gradPriceMultDays: lt[11],
        gradMinLiquidity: lt[12],
        gradLiquidityDays: lt[13],
      };
      const name = N?.status === "success" && typeof N.result === "string" ? N.result : "";
      const sym =
        S?.status === "success" && typeof S.result === "string" ? S.result : "";
      const tokenURI =
        U?.status === "success" && typeof U.result === "string" ? U.result : "";
      out.push({
        token: tokenAddresses[i]!,
        name,
        symbol: sym,
        tokenURI,
        launch: lr,
        curve: lr.bondingCurve,
      });
    }
    return out;
  }, [detailResults, tokenAddresses]);

  const metaQueries = useQueries({
    queries: parsedRows.map((row) => ({
      queryKey: ["hypa-token-meta", row.tokenURI],
      queryFn: () => fetchHypaTokenMetadata(row.tokenURI),
      enabled: Boolean(row.tokenURI?.trim()),
      staleTime: 60 * 60 * 1000,
    })),
  });

  const curveContracts = useMemo(() => {
    return parsedRows.flatMap((r) => [
      {
        chainId: deployChainId,
        address: r.curve,
        abi: bondingCurveReadAbi,
        functionName: "realEthReserve" as const,
      },
      {
        chainId: deployChainId,
        address: r.curve,
        abi: bondingCurveReadAbi,
        functionName: "GRADUATION_ETH_TARGET" as const,
      },
      {
        chainId: deployChainId,
        address: r.curve,
        abi: bondingCurveReadAbi,
        functionName: "graduated" as const,
      },
    ]);
  }, [parsedRows, deployChainId]);

  const { data: curveResults, isPending: curvePending } = useReadContracts({
    contracts: curveContracts,
    query: { enabled: curveContracts.length > 0, refetchInterval: 4_000 },
  });

  const curveStats = useMemo(() => {
    const list: { raised: bigint; target: bigint; graduated: boolean }[] = [];
    if (!curveResults?.length) {
      for (let i = 0; i < parsedRows.length; i++) {
        list.push({ raised: BigInt(0), target: BigInt(1), graduated: false });
      }
      return list;
    }
    for (let i = 0; i < parsedRows.length; i++) {
      const r0 = curveResults[i * 3];
      const r1 = curveResults[i * 3 + 1];
      const r2 = curveResults[i * 3 + 2];
      const raised =
        r0?.status === "success" && typeof r0.result === "bigint" ? r0.result : BigInt(0);
      const target =
        r1?.status === "success" && typeof r1.result === "bigint" ? r1.result : BigInt(1);
      const graduated =
        r2?.status === "success" && typeof r2.result === "boolean" ? r2.result : false;
      list.push({ raised, target, graduated });
    }
    return list;
  }, [curveResults, parsedRows.length]);

  const hotTokenOrder = useMemo(() => {
    const candidates: { token: Address; score: number }[] = [];
    for (let i = 0; i < parsedRows.length; i++) {
      const row = parsedRows[i];
      const cs = curveStats[i];
      if (!row || !cs || cs.graduated) continue; // only bonding tokens
      const progress = pctOnCurve(cs.raised, cs.target);
      const raisedEth = Number(formatEther(cs.raised));
      const launchedAtSec = Number(row.launch.launchedAt);
      const ageHours = Number.isFinite(launchedAtSec)
        ? Math.max(0, (Date.now() / 1000 - launchedAtSec) / 3600)
        : 48;
      const freshness = Math.max(0, 48 - ageHours); // favor recent movers
      const raisedScore = Math.log10(Math.max(1, raisedEth + 1)) * 18;
      const score = progress * 0.65 + raisedScore + freshness * 0.35;
      candidates.push({ token: row.token, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const cap = Math.min(6, Math.max(1, Math.ceil(candidates.length * 0.25)));
    return candidates.slice(0, cap).map((c) => c.token.toLowerCase());
  }, [parsedRows, curveStats]);
  const hotTokenSet = useMemo(() => new Set(hotTokenOrder), [hotTokenOrder]);

  const poolRows = useMemo(
    () =>
      parsedRows.map((r) => ({
        token: r.token,
        pool: r.launch.pool,
        graduated: r.launch.graduated,
      })),
    [parsedRows],
  );

  const poolEthMap = usePoolEthReserves(poolRows, weth, deployChainId);

  useWatchBlockNumber({
    chainId: deployChainId,
    poll: true,
    pollingInterval: 4_000,
    onBlockNumber: () => {
      void queryClient.invalidateQueries();
    },
  });

  const loading =
    totalPending ||
    (total > 0 &&
      (listPending || detailPending || !detailResults || curvePending));

  if (!totalPending && total === 0) {
    return (
      <div className="mt-10 rounded-2xl border border-border bg-surface-elevated/80 px-6 py-10 text-center">
        <p className="font-heading text-lg font-semibold text-fg">No tokens yet</p>
        <Link
          href="/launch"
          className="mt-6 inline-flex rounded-full bg-gradient-to-r from-accent to-accent-muted px-6 py-2.5 text-[0.875rem] font-semibold text-fg shadow-sm transition-[filter] hover:brightness-110"
        >
          Launch a token
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: Math.min(8, Math.max(4, total)) }).map((_, i) => (
          <div
            key={i}
            className="flex animate-pulse flex-col overflow-hidden rounded-xl border border-border bg-surface-elevated/50"
          >
            <div className="aspect-[2/1] w-full bg-surface-hover" />
            <div className="h-24 border-t border-border/40 bg-canvas/40" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-10 space-y-4">
      {walletMismatch ? (
        <p className="rounded-xl border border-border/80 bg-surface-elevated/60 px-4 py-2.5 text-[0.8125rem] text-team">
          Your wallet is on chain {walletChainId}. The list below reads the factory on chain{" "}
          {deployChainId} (deployment network).
        </p>
      ) : null}
      {hotTokenOrder.length > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center gap-1.5">
            <FireSimple size={14} weight="fill" className="text-orange-400" />
            <h3 className="font-heading text-[0.9rem] font-semibold tracking-wide text-fg">HOT</h3>
          </div>
          <div className="overflow-x-auto pb-1">
            <div className="flex min-w-max gap-2.5">
              {hotTokenOrder.map((tokenLower) => {
                const i = parsedRows.findIndex((r) => r.token.toLowerCase() === tokenLower);
                if (i < 0) return null;
                const row = parsedRows[i];
                const cs = curveStats[i] ?? { raised: BigInt(0), target: BigInt(1), graduated: false };
                const poolEth = poolEthMap.get(row.token.toLowerCase()) ?? null;
                const mq = metaQueries[i];
                const meta = mq?.data;
                const metaLoading = Boolean(row.tokenURI?.trim()) && (mq?.isPending ?? false);
                return (
                  <Link
                    key={`hot-${row.token}`}
                    href={`/token/${row.token}`}
                    className="group block h-full w-[15rem] shrink-0 rounded-xl outline-none transition-transform duration-200 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  >
                    <TokenCard
                      token={row.token}
                      name={row.name}
                      symbol={row.symbol}
                      launch={row.launch}
                      raisedWei={cs.raised}
                      gradTargetWei={cs.target}
                      curveGraduated={cs.graduated}
                      poolEthReserve={poolEth}
                      ethUsd={ethUsd ?? null}
                      ethUsdLoading={ethUsdLoading}
                      imageCandidates={meta?.imageCandidates ?? []}
                      metaLoading={metaLoading}
                      metaName={meta?.metaName}
                      isHot
                    />
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="font-heading text-[0.9rem] font-semibold tracking-wide text-fg">Explore Tokens</h3>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-4">
        {parsedRows.map((row) => {
          const i = parsedRows.findIndex((r) => r.token === row.token);
          const cs = curveStats[i] ?? { raised: BigInt(0), target: BigInt(1), graduated: false };
          const poolEth = poolEthMap.get(row.token.toLowerCase()) ?? null;
          const mq = metaQueries[i];
          const meta = mq?.data;
          const metaLoading = Boolean(row.tokenURI?.trim()) && (mq?.isPending ?? false);
          return (
            <Link
              key={row.token}
              href={`/token/${row.token}`}
              className="group block h-full rounded-xl outline-none transition-transform duration-200 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              <TokenCard
                token={row.token}
                name={row.name}
                symbol={row.symbol}
                launch={row.launch}
                raisedWei={cs.raised}
                gradTargetWei={cs.target}
                curveGraduated={cs.graduated}
                poolEthReserve={poolEth}
                ethUsd={ethUsd ?? null}
                ethUsdLoading={ethUsdLoading}
                imageCandidates={meta?.imageCandidates ?? []}
                metaLoading={metaLoading}
                metaName={meta?.metaName}
                isHot={hotTokenSet.has(row.token.toLowerCase())}
              />
            </Link>
          );
        })}
      </div>
      </section>
    </div>
  );
}
