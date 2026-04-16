"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { type Address, isAddress } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { predictionMarketAbi } from "../../lib/abis/prediction-market";
import { hypaTokenUriAbi, erc20NameSymbolAbi } from "../../lib/abis/home-reads";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";
import { deployments, PREDICTION_MARKET_ADDRESS } from "../../lib/deployments";
import { tokenFactoryAbi, TOKEN_FACTORY_ADDRESS } from "../../lib/token-factory";
import { MarketCard } from "../token/predictions-panel";

type LaunchTuple = readonly [
  Address,
  Address,
  Address,
  Address,
  Address,
  bigint,
  boolean,
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

type Filter = "all" | "pre" | "graduated";

export function AllPredictionsPanel({ ethUsd }: { ethUsd?: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const chainId = deployments.chainId;
  const pmAddress = PREDICTION_MARKET_ADDRESS;
  const { data: ethUsdLive } = useQuery({
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
  const usdToUse = ethUsd ?? ethUsdLive;

  const { data: totalBn, isPending: totalPending } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "totalLaunched",
    chainId,
  });

  const total = totalBn !== undefined ? Number(totalBn) : 0;

  const indexContracts = useMemo(() => {
    if (total <= 0) return [];
    return Array.from({ length: total }, (_, i) => ({
      chainId,
      address: TOKEN_FACTORY_ADDRESS,
      abi: tokenFactoryAbi,
      functionName: "allTokens" as const,
      args: [BigInt(i)] as const,
    }));
  }, [total, chainId]);

  const { data: allTokenResults, isPending: tokensPending } = useReadContracts({
    contracts: indexContracts,
    query: { enabled: indexContracts.length > 0 },
  });

  const tokenAddresses = useMemo(() => {
    if (!allTokenResults?.length) return [] as Address[];
    const out: Address[] = [];
    for (const row of allTokenResults) {
      if (row.status !== "success" || !row.result) continue;
      const token = row.result as Address;
      if (isAddress(token)) out.push(token);
    }
    return out;
  }, [allTokenResults]);

  const tokenMetaContracts = useMemo(() => {
    return tokenAddresses.flatMap((token) => [
      {
        chainId,
        address: TOKEN_FACTORY_ADDRESS,
        abi: tokenFactoryAbi,
        functionName: "launches" as const,
        args: [token] as const,
      },
      {
        chainId,
        address: token,
        abi: erc20NameSymbolAbi,
        functionName: "symbol" as const,
      },
      {
        chainId,
        address: token,
        abi: hypaTokenUriAbi,
        functionName: "tokenURI" as const,
      },
      {
        chainId,
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "getTokenMarkets" as const,
        args: [token] as const,
      },
    ]);
  }, [tokenAddresses, chainId, pmAddress]);

  const { data: tokenMetaResults, isPending: tokenMetaPending } = useReadContracts({
    contracts: tokenMetaContracts,
    query: { enabled: tokenMetaContracts.length > 0 },
  });

  const tokenRows = useMemo(() => {
    if (!tokenMetaResults?.length) {
      return [] as {
        token: Address;
        symbol: string;
        tokenURI: string;
        graduated: boolean;
        marketIds: bigint[];
      }[];
    }
    const rows: {
      token: Address;
      symbol: string;
      tokenURI: string;
      graduated: boolean;
      marketIds: bigint[];
    }[] = [];
    for (let i = 0; i < tokenAddresses.length; i++) {
      const base = i * 4;
      const launchR = tokenMetaResults[base];
      const symbolR = tokenMetaResults[base + 1];
      const uriR = tokenMetaResults[base + 2];
      const marketsR = tokenMetaResults[base + 3];
      const launchTuple =
        launchR?.status === "success" && launchR.result
          ? (launchR.result as unknown as LaunchTuple)
          : null;
      const graduated = launchTuple?.[6] ?? false;
      const symbol =
        symbolR?.status === "success" && typeof symbolR.result === "string"
          ? symbolR.result
          : "???";
      const tokenURI =
        uriR?.status === "success" && typeof uriR.result === "string"
          ? uriR.result
          : "";
      const marketIds =
        marketsR?.status === "success" && Array.isArray(marketsR.result)
          ? (marketsR.result as bigint[])
          : [];
      rows.push({
        token: tokenAddresses[i]!,
        symbol,
        tokenURI,
        graduated,
        marketIds,
      });
    }
    return rows;
  }, [tokenMetaResults, tokenAddresses]);

  const metaQueries = useQueries({
    queries: tokenRows.map((row) => ({
      queryKey: ["hypa-token-meta", row.tokenURI],
      queryFn: () => fetchHypaTokenMetadata(row.tokenURI),
      enabled: Boolean(row.tokenURI?.trim()),
      staleTime: 60 * 60 * 1000,
    })),
  });

  const imageByToken = useMemo(() => {
    const m = new Map<string, string | undefined>();
    tokenRows.forEach((row, i) => {
      m.set(row.token.toLowerCase(), metaQueries[i]?.data?.imageCandidates?.[0]);
    });
    return m;
  }, [tokenRows, metaQueries]);

  const allMarkets = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const out: {
      marketId: bigint;
      token: Address;
      symbol: string;
      tokenImage?: string;
      graduated: boolean;
    }[] = [];
    tokenRows.forEach((row) => {
      row.marketIds.forEach((mid) => {
        out.push({
          marketId: mid,
          token: row.token,
          symbol: row.symbol,
          tokenImage: imageByToken.get(row.token.toLowerCase()),
          graduated: row.graduated,
        });
      });
    });
    return { nowSec, rows: out };
  }, [tokenRows, imageByToken]);

  const marketContracts = useMemo(
    () =>
      allMarkets.rows.map((row) => ({
        chainId,
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "getMarket" as const,
        args: [row.marketId] as const,
      })),
    [allMarkets.rows, chainId, pmAddress],
  );

  const { data: marketDataResults, isPending: marketsPending } = useReadContracts({
    contracts: marketContracts,
    query: { enabled: marketContracts.length > 0 },
  });

  /** Open markets still accepting stakes: status Open and deadline not passed. */
  const activeFiltered = useMemo(() => {
    if (!marketDataResults?.length) return [];
    const nowSec = allMarkets.nowSec;
    const rows: typeof allMarkets.rows = [];
    for (let i = 0; i < allMarkets.rows.length; i++) {
      const res = marketDataResults[i];
      if (res?.status !== "success" || !res.result) continue;
      const market = res.result as { deadline: bigint; status: number };
      if (market.status !== 0) continue;
      const deadline = Number(market.deadline);
      const isExpired = deadline > 0 && nowSec >= deadline;
      if (isExpired) continue;
      const base = allMarkets.rows[i]!;
      if (filter === "pre" && base.graduated) continue;
      if (filter === "graduated" && !base.graduated) continue;
      rows.push(base);
    }
    return rows;
  }, [marketDataResults, allMarkets, filter]);

  const loading = totalPending || tokensPending || tokenMetaPending || marketsPending;

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-accent"
          aria-label="Loading predictions"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition-colors ${
            filter === "all" ? "bg-accent text-fg" : "text-team hover:text-fg"
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setFilter("pre")}
          className={`rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition-colors ${
            filter === "pre" ? "bg-accent text-fg" : "text-team hover:text-fg"
          }`}
        >
          Pre Graduation
        </button>
        <button
          type="button"
          onClick={() => setFilter("graduated")}
          className={`rounded-full px-4 py-1.5 text-[0.8rem] font-semibold transition-colors ${
            filter === "graduated" ? "bg-accent text-fg" : "text-team hover:text-fg"
          }`}
        >
          Graduated
        </button>
      </div>

      {activeFiltered.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-elevated/80 p-6 text-center text-[0.875rem] text-team">
          No active predictions found.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3">
          {activeFiltered.map((row) => (
            <Link
              key={`${row.token}-${row.marketId.toString()}`}
              href={`/token/${row.token}`}
              className="group block min-h-0 min-w-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              <MarketCard
                marketId={row.marketId}
                pmAddress={pmAddress}
                chainId={chainId}
                tokenSymbol={row.symbol}
                tokenImage={row.tokenImage}
                ethUsd={usdToUse}
                align="left"
                gridCell
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
