"use client";

import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "@phosphor-icons/react";
import { getPublicClient } from "@wagmi/core";
import { useCallback, useMemo, useState } from "react";
import { type Address, formatEther, isAddressEqual, type Abi, zeroAddress } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { useAccount, useConfig, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import Link from "next/link";
import { erc20NameSymbolAbi, hypaTokenUriAbi } from "../../lib/abis/home-reads";
import { deployments } from "../../lib/deployments";
import { fetchHypaTokenMetadata } from "../../lib/ipfs";
import { TOKEN_FACTORY_ADDRESS, tokenFactoryAbi } from "../../lib/token-factory";

type LaunchTuple = readonly [
  Address, // token
  Address, // bondingCurve
  Address, // devVesting
  Address, // pool
  Address, // dev
  bigint, // launchedAt
  boolean, // graduated
  number,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

const curveCreatorFeeAbi = [
  {
    inputs: [],
    name: "pendingCreatorFees",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "creator",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "claimCreatorFees",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const satisfies Abi;

function withIntCommas(numericString: string): string {
  const parts = numericString.split(".");
  const intRaw = parts[0] ?? "";
  const sign = intRaw.startsWith("-") ? "-" : "";
  const digits = sign ? intRaw.slice(1) : intRaw;
  if (!digits) return numericString;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = parts[1];
  return frac !== undefined ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

function fmtEth(wei: bigint): string {
  const raw = formatEther(wei);
  const [intPart, frac = ""] = raw.split(".");
  const shortFrac = frac.replace(/0+$/, "").slice(0, 6);
  const combined = shortFrac ? `${intPart}.${shortFrac}` : intPart;
  return withIntCommas(combined);
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1 ? 2 : 4,
  }).format(n);
}

export function CreatorRevenuePanel() {
  const config = useConfig();
  const qc = useQueryClient();
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const chainId = deployments.chainId;

  const [claimingCurve, setClaimingCurve] = useState<Address | null>(null);
  const [copiedToken, setCopiedToken] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const { data: devTokensRaw, isPending: devTokensPending } = useReadContract({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "getDevTokens",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: isConnected && Boolean(address) },
  });

  const devTokens = (devTokensRaw as Address[] | undefined) ?? [];

  const launchContracts = useMemo(
    () =>
      devTokens.map((token) => ({
        address: TOKEN_FACTORY_ADDRESS,
        abi: tokenFactoryAbi,
        functionName: "launches" as const,
        args: [token] as const,
        chainId,
      })),
    [devTokens, chainId],
  );

  const { data: launchRows } = useReadContracts({
    contracts: launchContracts,
    query: { enabled: launchContracts.length > 0 },
  });

  const tokenMetaContracts = useMemo(
    () =>
      devTokens.flatMap((token) => [
        { address: token, abi: erc20NameSymbolAbi, functionName: "name" as const, args: [] as const, chainId },
        { address: token, abi: erc20NameSymbolAbi, functionName: "symbol" as const, args: [] as const, chainId },
      ]),
    [devTokens, chainId],
  );

  const { data: tokenMetaRows } = useReadContracts({
    contracts: tokenMetaContracts,
    query: { enabled: tokenMetaContracts.length > 0 },
  });

  const tokenUriContracts = useMemo(
    () =>
      devTokens.map((token) => ({
        address: token,
        abi: hypaTokenUriAbi,
        functionName: "tokenURI" as const,
        args: [] as const,
        chainId,
      })),
    [devTokens, chainId],
  );

  const { data: tokenUriRows } = useReadContracts({
    contracts: tokenUriContracts,
    query: { enabled: tokenUriContracts.length > 0 },
  });

  const tokenUris = useMemo(
    () =>
      devTokens.map((_, i) => {
        const r = tokenUriRows?.[i];
        if (!r || r.status !== "success") return "";
        return (r.result as string) ?? "";
      }),
    [devTokens, tokenUriRows],
  );

  const tokenMetaQueries = useQueries({
    queries: tokenUris.map((tokenUri, i) => ({
      queryKey: ["creator-token-meta", devTokens[i], tokenUri],
      queryFn: () => fetchHypaTokenMetadata(tokenUri),
      enabled: Boolean(tokenUri?.trim()),
      staleTime: 60 * 60 * 1000,
    })),
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

  const curves = useMemo(
    () =>
      devTokens.map((_, i) => {
        const r = launchRows?.[i];
        if (!r || r.status !== "success") return zeroAddress;
        const launch = r.result as LaunchTuple;
        return launch[1] as Address;
      }),
    [devTokens, launchRows],
  );

  const curveContracts = useMemo(
    () =>
      curves.flatMap((curve) =>
        curve && curve !== zeroAddress
          ? [
              { address: curve, abi: curveCreatorFeeAbi, functionName: "pendingCreatorFees" as const, args: [] as const, chainId },
              { address: curve, abi: curveCreatorFeeAbi, functionName: "creator" as const, args: [] as const, chainId },
            ]
          : [],
      ),
    [curves, chainId],
  );

  const { data: curveRows } = useReadContracts({
    contracts: curveContracts,
    query: { enabled: curveContracts.length > 0, refetchInterval: 10_000 },
  });

  const rows = useMemo(() => {
    const out: {
      token: Address;
      curve: Address;
      name: string;
      symbol: string;
      pending: bigint;
      image?: string;
      isCreator: boolean;
    }[] = [];

    let curveIdx = 0;
    for (let i = 0; i < devTokens.length; i++) {
      const token = devTokens[i];
      const curve = curves[i];
      if (!curve || curve === zeroAddress) continue;

      const nameRes = tokenMetaRows?.[i * 2];
      const symbolRes = tokenMetaRows?.[i * 2 + 1];
      const pendingRes = curveRows?.[curveIdx * 2];
      const creatorRes = curveRows?.[curveIdx * 2 + 1];
      curveIdx += 1;

      const name = nameRes?.status === "success" ? (nameRes.result as string) : "Token";
      const symbol = symbolRes?.status === "success" ? (symbolRes.result as string) : "???";
      const pending = pendingRes?.status === "success" ? (pendingRes.result as bigint) : BigInt(0);
      const creator = creatorRes?.status === "success" ? (creatorRes.result as Address) : zeroAddress;
      const image = tokenMetaQueries[i]?.data?.imageCandidates?.[0];

      out.push({
        token,
        curve,
        name,
        symbol,
        pending,
        image,
        isCreator: Boolean(address && isAddressEqual(creator, address)),
      });
    }
    return out;
  }, [devTokens, curves, tokenMetaRows, curveRows, tokenMetaQueries, address]);

  const totalPending = useMemo(
    () => rows.reduce((acc, row) => (row.isCreator ? acc + row.pending : acc), BigInt(0)),
    [rows],
  );
  const totalPendingUsd = useMemo(() => {
    if (ethUsd === undefined) return null;
    return Number(formatEther(totalPending)) * ethUsd;
  }, [totalPending, ethUsd]);

  const copyToken = useCallback((token: Address) => {
    void navigator.clipboard.writeText(token).then(() => {
      setCopiedToken(token);
      window.setTimeout(() => setCopiedToken((v) => (v === token ? null : v)), 1500);
    });
  }, []);

  const onClaim = useCallback(
    async (curve: Address, symbol: string) => {
      try {
        setError(null);
        setSuccess(null);
        setClaimingCurve(curve);
        const hash = await writeContractAsync({
          address: curve,
          abi: curveCreatorFeeAbi,
          functionName: "claimCreatorFees",
          args: [],
          chainId,
        });
        const pc = getPublicClient(config, { chainId });
        if (!pc) throw new Error("No public client");
        await waitForTransactionReceipt(pc, { hash });
        setSuccess(`Claimed creator fees for ${symbol}.`);
        await qc.invalidateQueries();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Claim failed";
        setError(
          msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("user denied")
            ? "Transaction rejected."
            : "Claim failed. Please try again.",
        );
      } finally {
        setClaimingCurve(null);
      }
    },
    [writeContractAsync, config, chainId, qc],
  );

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-border bg-surface-elevated/80 p-8 text-center text-[0.9rem] text-team">
        Connect your wallet to view and claim your creator fee revenue.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface-elevated/85 p-4 sm:p-5">
        <p className="text-[0.8rem] text-team">
          Bonding curve trades charge 1% total fee: <span className="text-fg">0.8%</span> goes to treasury and{" "}
          <span className="text-fg">0.2%</span> accrues on each curve for its creator.
        </p>
        <p className="mt-3 font-mono text-[0.95rem] text-emerald-200">
          Total claimable: {fmtEth(totalPending)} ETH
          {totalPendingUsd !== null ? (
            <span className="ml-2 text-[0.82rem] text-team">({fmtUsd(totalPendingUsd)})</span>
          ) : null}
        </p>
      </div>

      {devTokensPending ? (
        <div className="rounded-xl border border-border bg-surface-elevated/70 p-6 text-center text-team">Loading your launches…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-elevated/70 p-6 text-center text-team">
          No creator launches found for this wallet.
        </div>
      ) : (
        <div className="space-y-2.5">
          {rows.map((row) => {
            const busy = claimingCurve !== null;
            const isClaimingThis = claimingCurve === row.curve;
            const disabled = busy || !row.isCreator || row.pending <= BigInt(0);
            return (
              <div
                key={row.curve}
                className="group/card flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-surface-elevated/70 px-4 py-3 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/45 hover:shadow-[0_10px_30px_-20px_rgba(0,0,0,0.9)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/token/${row.token}`}
                      className="shrink-0 overflow-hidden rounded-full border border-border bg-canvas"
                      aria-label={`Open ${row.symbol} page`}
                    >
                      {row.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={row.image} alt="" className="h-8 w-8 object-cover" />
                      ) : (
                        <div className="flex h-8 w-8 items-center justify-center text-[0.62rem] font-bold text-accent">
                          {row.symbol.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </Link>
                    <p className="truncate font-heading text-[0.95rem] font-semibold text-fg">
                      {row.name}{" "}
                      <span className="group/ticker inline-flex items-center gap-1 text-accent">
                        ${row.symbol}
                        <button
                          type="button"
                          onClick={() => copyToken(row.token)}
                          className="rounded-sm p-0.5 text-team opacity-0 transition-[opacity,color] hover:text-fg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/50 group-hover/ticker:opacity-100"
                          aria-label={`Copy ${row.symbol} token address`}
                          title="Copy token address"
                        >
                          {copiedToken === row.token ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
                        </button>
                      </span>
                    </p>
                  </div>
                  <p className="mt-0.5 truncate text-[0.72rem] text-muted">Curve: {row.curve}</p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-right font-mono text-[0.83rem] text-team">
                    <span>{fmtEth(row.pending)} ETH</span>
                    {ethUsd !== undefined ? (
                      <span className="block text-[0.72rem] text-muted">
                        {fmtUsd(Number(formatEther(row.pending)) * ethUsd)}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void onClaim(row.curve, row.symbol)}
                    className="inline-flex min-w-[8rem] items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[0.78rem] font-semibold text-fg transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isClaimingThis ? (
                      <>
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-fg/30 border-t-fg" aria-hidden />
                        Confirming…
                      </>
                    ) : row.pending > BigInt(0) ? (
                      "Claim 0.2% fees"
                    ) : (
                      "Nothing to claim"
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <p className="rounded-xl border border-red-900/40 bg-red-950/25 px-3 py-2 text-[0.8rem] text-red-200">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded-xl border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-[0.8rem] text-emerald-300">{success}</p>
      ) : null}
    </div>
  );
}

