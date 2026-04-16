"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { ComponentProps } from "react";
import { useCallback, useMemo, useState } from "react";
import { type Address, formatEther, isAddress } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { getPublicClient } from "@wagmi/core";
import type { Config } from "@wagmi/core";
import { useAccount, useConfig, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { predictionMarketAbi } from "../../lib/abis/prediction-market";
import { hypaTokenUriAbi, erc20NameSymbolAbi } from "../../lib/abis/home-reads";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";
import { deployments, PREDICTION_MARKET_ADDRESS } from "../../lib/deployments";
import { tokenFactoryAbi, TOKEN_FACTORY_ADDRESS } from "../../lib/token-factory";
import { MarketCard } from "../token/predictions-panel";

/** `MarketType.POST_MCAP_RANGE` in PredictionMarket.sol */
const MARKET_TYPE_POST_MCAP_RANGE = 5;
const STATUS_OPEN = 0;
const STATUS_RESOLVED = 1;
const STATUS_CANCELLED = 2;

type MarketTuple = {
  status: number;
  marketType: number;
  outcome: boolean;
  deadline: bigint;
};

function fmt(wei: bigint, dec = 4): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  const t = f.replace(/0+$/, "").slice(0, dec);
  return t ? `${i}.${t}` : i;
}

async function waitTx(config: Config, chainId: number, hash: `0x${string}`) {
  const pc = getPublicClient(config, { chainId });
  if (!pc) throw new Error("no public client");
  await waitForTransactionReceipt(pc, { hash });
}

function rowKey(token: Address, marketId: bigint) {
  return `${token.toLowerCase()}-${marketId.toString()}`;
}

export function UserStakesPanel() {
  const chainId = deployments.chainId;
  const pmAddress = PREDICTION_MARKET_ADDRESS;
  const config = useConfig();
  const queryClient = useQueryClient();
  const { address: userAddress } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [actionKey, setActionKey] = useState<string | null>(null);

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
        marketIds: bigint[];
      }[];
    }
    const rows: {
      token: Address;
      symbol: string;
      tokenURI: string;
      marketIds: bigint[];
    }[] = [];
    for (let i = 0; i < tokenAddresses.length; i++) {
      const base = i * 4;
      const launchR = tokenMetaResults[base];
      const symbolR = tokenMetaResults[base + 1];
      const uriR = tokenMetaResults[base + 2];
      const marketsR = tokenMetaResults[base + 3];
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
      void launchR;
      rows.push({
        token: tokenAddresses[i]!,
        symbol,
        tokenURI,
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

  const flatRows = useMemo(() => {
    const out: {
      marketId: bigint;
      token: Address;
      symbol: string;
      tokenImage?: string;
    }[] = [];
    tokenRows.forEach((row) => {
      row.marketIds.forEach((mid) => {
        out.push({
          marketId: mid,
          token: row.token,
          symbol: row.symbol,
          tokenImage: imageByToken.get(row.token.toLowerCase()),
        });
      });
    });
    return out;
  }, [tokenRows, imageByToken]);

  const tripletContracts = useMemo(() => {
    if (!userAddress || flatRows.length === 0) return [];
    return flatRows.flatMap((r) => [
      {
        chainId,
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "getMarket" as const,
        args: [r.marketId] as const,
      },
      {
        chainId,
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "getUserStakes" as const,
        args: [r.marketId, userAddress] as const,
      },
      {
        chainId,
        address: pmAddress,
        abi: predictionMarketAbi,
        functionName: "claimed" as const,
        args: [r.marketId, userAddress] as const,
      },
    ]);
  }, [flatRows, userAddress, chainId, pmAddress]);

  const { data: tripletResults, isPending: tripletPending } = useReadContracts({
    contracts: tripletContracts,
    query: { enabled: tripletContracts.length > 0 },
  });

  const rangeContracts = useMemo(() => {
    if (!userAddress || !tripletResults?.length || flatRows.length === 0) return [];
    const out: {
      chainId: number;
      address: typeof pmAddress;
      abi: typeof predictionMarketAbi;
      functionName: "rangeStakes";
      args: readonly [bigint, number, Address];
    }[] = [];
    for (let i = 0; i < flatRows.length; i++) {
      const mRes = tripletResults[i * 3];
      const stRes = tripletResults[i * 3 + 1];
      if (mRes?.status !== "success" || !mRes.result || stRes?.status !== "success") continue;
      const market = mRes.result as MarketTuple;
      const [y, n] = stRes.result as readonly [bigint, bigint];
      if (market.marketType !== MARKET_TYPE_POST_MCAP_RANGE) continue;
      if (y > BigInt(0) || n > BigInt(0)) continue;
      const id = flatRows[i]!.marketId;
      for (let b = 0; b < 4; b++) {
        out.push({
          chainId,
          address: pmAddress,
          abi: predictionMarketAbi,
          functionName: "rangeStakes",
          args: [id, b, userAddress],
        });
      }
    }
    return out;
  }, [tripletResults, flatRows, userAddress, chainId, pmAddress]);

  const { data: rangeResults, isPending: rangePending } = useReadContracts({
    contracts: rangeContracts,
    query: { enabled: rangeContracts.length > 0 },
  });

  const rangeTotalByMarketId = useMemo(() => {
    const map = new Map<string, bigint>();
    if (!rangeResults?.length || !tripletResults?.length) return map;
    let rIdx = 0;
    for (let i = 0; i < flatRows.length; i++) {
      const mRes = tripletResults[i * 3];
      const stRes = tripletResults[i * 3 + 1];
      if (mRes?.status !== "success" || !mRes.result || stRes?.status !== "success") continue;
      const market = mRes.result as MarketTuple;
      const [y, n] = stRes.result as readonly [bigint, bigint];
      if (market.marketType !== MARKET_TYPE_POST_MCAP_RANGE) continue;
      if (y > BigInt(0) || n > BigInt(0)) continue;
      let sum = BigInt(0);
      for (let b = 0; b < 4; b++) {
        const rr = rangeResults[rIdx++];
        if (rr?.status === "success" && typeof rr.result === "bigint") sum += rr.result;
      }
      map.set(flatRows[i]!.marketId.toString(), sum);
    }
    return map;
  }, [rangeResults, tripletResults, flatRows]);

  const stakeRows = useMemo(() => {
    if (!tripletResults?.length || !userAddress) return [];
    const out: {
      token: Address;
      marketId: bigint;
      symbol: string;
      tokenImage?: string;
      market: MarketTuple;
      userYes: bigint;
      userNo: bigint;
      rangeTotal: bigint;
      claimed: boolean;
    }[] = [];
    for (let i = 0; i < flatRows.length; i++) {
      const mRes = tripletResults[i * 3];
      const stRes = tripletResults[i * 3 + 1];
      const clRes = tripletResults[i * 3 + 2];
      if (mRes?.status !== "success" || !mRes.result) continue;
      if (stRes?.status !== "success" || !stRes.result) continue;
      const market = mRes.result as MarketTuple;
      const [y, n] = stRes.result as readonly [bigint, bigint];
      const claimed = clRes?.status === "success" && typeof clRes.result === "boolean" ? clRes.result : false;
      const rangeTotal =
        market.marketType === MARKET_TYPE_POST_MCAP_RANGE && !(y > BigInt(0) || n > BigInt(0))
          ? (rangeTotalByMarketId.get(flatRows[i]!.marketId.toString()) ?? BigInt(0))
          : BigInt(0);
      const hasBinary = y > BigInt(0) || n > BigInt(0);
      const hasRange = rangeTotal > BigInt(0);
      if (!hasBinary && !hasRange) continue;
      const base = flatRows[i]!;
      out.push({
        token: base.token,
        marketId: base.marketId,
        symbol: base.symbol,
        tokenImage: base.tokenImage,
        market,
        userYes: y,
        userNo: n,
        rangeTotal,
        claimed,
      });
    }
    return out;
  }, [tripletResults, flatRows, userAddress, rangeTotalByMarketId]);

  const pendingContracts = useMemo(
    () =>
      userAddress && stakeRows.length > 0
        ? stakeRows.map((r) => ({
            chainId,
            address: pmAddress,
            abi: predictionMarketAbi,
            functionName: "pendingWinnings" as const,
            args: [r.marketId, userAddress] as const,
          }))
        : [],
    [stakeRows, userAddress, chainId, pmAddress],
  );

  const { data: pendingResults, isPending: pendingPending } = useReadContracts({
    contracts: pendingContracts,
    query: { enabled: pendingContracts.length > 0 },
  });

  const pendingByIndex = useMemo(() => {
    const arr: bigint[] = [];
    if (!pendingResults?.length) return arr;
    for (let i = 0; i < stakeRows.length; i++) {
      const r = pendingResults[i];
      arr.push(r?.status === "success" && typeof r.result === "bigint" ? r.result : BigInt(0));
    }
    return arr;
  }, [pendingResults, stakeRows.length]);

  const doClaimAction = useCallback(
    async (
      row: { marketId: bigint; market: MarketTuple; token: Address },
      kind: "claim" | "claimRange" | "refund",
    ) => {
      const k = rowKey(row.token, row.marketId);
      setActionKey(k);
      try {
        const hash = await writeContractAsync({
          address: pmAddress,
          abi: predictionMarketAbi,
          functionName: kind as "claim" | "claimRange" | "refund",
          args: [row.marketId],
          chainId,
        });
        await waitTx(config, chainId, hash);
        await queryClient.invalidateQueries();
      } finally {
        setActionKey(null);
      }
    },
    [writeContractAsync, pmAddress, chainId, config, queryClient],
  );

  const loading =
    totalPending ||
    tokensPending ||
    tokenMetaPending ||
    (Boolean(userAddress) && flatRows.length > 0 && tripletPending) ||
    (rangeContracts.length > 0 && rangePending) ||
    (pendingContracts.length > 0 && pendingPending);

  if (!userAddress) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/80 p-8 text-center text-[0.875rem] text-team">
        Connect your wallet to see markets you have staked on.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-border border-t-accent"
          aria-label="Loading your stakes"
        />
      </div>
    );
  }

  if (stakeRows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/80 p-8 text-center text-[0.875rem] text-team">
        No stakes found for your wallet across Hypapad tokens. Open a token and use Predictions to enter a market.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3">
      {stakeRows.map((row, idx) => {
        const pendingWei = pendingByIndex[idx] ?? BigInt(0);
        const k = rowKey(row.token, row.marketId);
        const busy = actionKey === k;
        const hasAny = row.userYes > BigInt(0) || row.userNo > BigInt(0) || row.rangeTotal > BigInt(0);
        const rangePositionText =
          row.market.marketType === MARKET_TYPE_POST_MCAP_RANGE && row.rangeTotal > BigInt(0)
            ? `Mcap range buckets: ${fmt(row.rangeTotal)} ETH total`
            : null;

        type Footer = NonNullable<ComponentProps<typeof MarketCard>["stakesFooter"]>;
        let stakesFooter: Footer | null = null;

        if (row.claimed) {
          stakesFooter = { statusNote: "You already claimed or refunded for this market." };
        } else if (row.market.status === STATUS_RESOLVED && pendingWei > BigInt(0)) {
          const fn = row.market.marketType === MARKET_TYPE_POST_MCAP_RANGE ? "claimRange" : "claim";
          stakesFooter = {
            claimLabel: `Claim ${fmt(pendingWei)} ETH`,
            onClaim: () => void doClaimAction(row, fn),
            claimBusy: busy,
          };
        } else if (row.market.status === STATUS_CANCELLED && hasAny) {
          stakesFooter = {
            refundLabel: "Refund my stake",
            onRefund: () => void doClaimAction(row, "refund"),
            refundBusy: busy,
          };
        } else if (row.market.status === STATUS_RESOLVED && hasAny) {
          stakesFooter = {
            statusNote: "Resolved — no claimable winnings for you on this outcome.",
          };
        } else if (row.market.status === STATUS_OPEN) {
          const dl = Number(row.market.deadline);
          const expired = dl > 0 && Date.now() / 1000 > dl;
          stakesFooter = {
            statusNote: expired
              ? "Deadline passed — waiting for resolution. Claim appears here once resolved."
              : "Market still open. Add to your position from the token page.",
          };
        } else {
          stakesFooter = {
            statusNote: "No action available.",
          };
        }

        return (
          <Link
            key={k}
            href={`/token/${row.token}`}
            className="group block min-h-0 min-w-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <MarketCard
              marketId={row.marketId}
              pmAddress={pmAddress}
              chainId={chainId}
              userAddress={userAddress}
              tokenSymbol={row.symbol}
              tokenImage={row.tokenImage}
              ethUsd={ethUsd}
              align="left"
              gridCell
              hideTrade
              rangePositionText={rangePositionText}
              stakesFooter={stakesFooter}
            />
          </Link>
        );
      })}
    </div>
  );
}
