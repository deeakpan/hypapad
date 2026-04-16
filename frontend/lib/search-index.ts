import { createPublicClient, formatEther, formatUnits, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { deployments, TOKEN_FACTORY_ADDRESS, PREDICTION_MARKET_ADDRESS } from "./deployments";
import { tokenFactoryAbi } from "./token-factory";
import { erc20NameSymbolAbi, hypaTokenUriAbi, uniswapV2PairAbi } from "./abis/home-reads";
import { predictionMarketAbi } from "./abis/prediction-market";
import { bondingCurveTradeAbi } from "./abis/bonding-curve-trade";
import { erc20BalanceAllowanceAbi } from "./abis/erc20-trade";
import { ipfsPathFromUri } from "./ipfs";

export type SearchTokenItem = {
  type: "token";
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  imageUrl: string | null;
  state: "bonding" | "graduated";
  priceUsd: number | null;
  launchedAt: number | null;
  href: string;
};

export type SearchMarketItem = {
  type: "market";
  marketId: string;
  token: Address;
  tokenSymbol: string;
  description: string;
  state: "open" | "ended";
  href: string;
};

export type SearchIndex = {
  tokens: SearchTokenItem[];
  markets: SearchMarketItem[];
};

function chainForDeployments() {
  if (deployments.chainId === base.id) return base;
  if (deployments.chainId === baseSepolia.id) return baseSepolia;
  return baseSepolia;
}

function rpcUrlForChain(): string {
  const fromEnv = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL;
  if (fromEnv) return fromEnv;
  return chainForDeployments().rpcUrls.default.http[0];
}

function includesCI(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function rankTextMatch(fields: string[], q: string): number {
  const qq = q.toLowerCase();
  let score = 0;
  for (const f of fields) {
    const x = f.toLowerCase();
    if (!x) continue;
    if (x === qq) score += 120;
    else if (x.startsWith(qq)) score += 80;
    else if (x.includes(qq)) score += 30;
  }
  return score;
}

function fmtEthCompact(wei: bigint, dec = 4): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  const t = f.replace(/0+$/, "").slice(0, dec);
  return t ? `${i}.${t}` : i;
}

function displayTicker(raw: string): string {
  const s = raw.trim();
  if (!s) return "$???";
  return s.startsWith("$") ? s : `$${s}`;
}

function fallbackMarketQuestion(
  marketType: number,
  tokenSymbol: string,
  ethTarget: bigint,
  multiplierX10: bigint,
  minLiquidity: bigint,
): string {
  const tick = displayTicker(tokenSymbol);
  if (marketType === 0) return `Will ${tick} graduate within 24h?`;
  if (marketType === 1) return `Will ${tick} graduate within 72h?`;
  if (marketType === 2) return `Will ETH raised hit ${fmtEthCompact(ethTarget)} ETH before deadline?`;
  if (marketType === 3 || marketType === 6) {
    const mult = Number(multiplierX10) / 10;
    return `Will price reach ${mult}x before deadline?`;
  }
  if (marketType === 4) {
    const mult = Number(multiplierX10) / 10;
    return `Will mcap reach ${mult}x before deadline?`;
  }
  if (marketType === 7) return `Will pool keep >${fmtEthCompact(minLiquidity)} ETH liquidity?`;
  return "Custom market";
}

function withTickerPrefix(description: string, tokenSymbol: string): string {
  const out = description.trim();
  if (!out) return `${displayTicker(tokenSymbol)} · Market`;
  const tick = displayTicker(tokenSymbol);
  const low = out.toLowerCase();
  const sym = tokenSymbol.trim().toLowerCase();
  if (low.includes(tick.toLowerCase()) || (sym && low.includes(sym))) return out;
  return `${tick} · ${out}`;
}

function getTupleField<T>(row: unknown, key: string, index: number): T | undefined {
  if (row && typeof row === "object" && key in (row as Record<string, unknown>)) {
    return (row as Record<string, unknown>)[key] as T;
  }
  if (Array.isArray(row)) return row[index] as T;
  return undefined;
}

const IPFS_GATEWAYS = [
  "https://gateway.lighthouse.storage/ipfs/",
  "https://dweb.link/ipfs/",
  "https://cf-ipfs.com/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

function fetchWithTimeout(url: string, timeoutMs = 12_000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function tryFetchJson(urls: string[]): Promise<Record<string, unknown> | null> {
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) continue;
      const parsed = (await r.json()) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

function imageUrlFromMetadataImage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const ipfsPath = ipfsPathFromUri(t);
  if (ipfsPath) return `/api/ipfs-fetch?path=${encodeURIComponent(ipfsPath)}`;
  if (t.startsWith("http://") || t.startsWith("https://") || t.startsWith("data:")) return t;
  return null;
}

async function resolveTokenImageFromTokenUri(tokenURI: string): Promise<string | null> {
  const uri = tokenURI.trim();
  if (!uri) return null;
  let metadata: Record<string, unknown> | null = null;

  const ipfsPath = ipfsPathFromUri(uri);
  if (ipfsPath) {
    metadata = await tryFetchJson(IPFS_GATEWAYS.map((g) => `${g}${ipfsPath}`));
  } else if (uri.startsWith("http://") || uri.startsWith("https://")) {
    metadata = await tryFetchJson([uri]);
  }
  if (!metadata) return null;
  return imageUrlFromMetadataImage(metadata.image);
}

async function loadEthUsdPrice(): Promise<number | null> {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { next: { revalidate: 60 } },
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { ethereum?: { usd?: number } };
    const usd = data.ethereum?.usd;
    return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
  } catch {
    return null;
  }
}

export async function loadSearchIndex(): Promise<SearchIndex> {
  const chain = chainForDeployments();
  const pc = createPublicClient({
    chain,
    transport: http(rpcUrlForChain()),
  });

  const total = Number(
    await pc.readContract({
      address: TOKEN_FACTORY_ADDRESS,
      abi: tokenFactoryAbi,
      functionName: "totalLaunched",
    }),
  );
  if (total <= 0) return { tokens: [], markets: [] };

  const allTokenCalls = Array.from({ length: total }, (_, i) => ({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "allTokens" as const,
    args: [BigInt(i)] as const,
  }));
  const allTokenRows = await pc.multicall({
    contracts: allTokenCalls as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });
  const tokenAddresses = allTokenRows
    .map((r) => (r.status === "success" ? (r.result as Address) : null))
    .filter(Boolean) as Address[];

  const launchRows = await pc.multicall({
    contracts: tokenAddresses.map((token) => ({
      address: TOKEN_FACTORY_ADDRESS,
      abi: tokenFactoryAbi,
      functionName: "launches" as const,
      args: [token] as const,
    })) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const metaRows = await pc.multicall({
    contracts: tokenAddresses.flatMap((token) => [
      { address: token, abi: erc20NameSymbolAbi, functionName: "name" as const, args: [] as const },
      { address: token, abi: erc20NameSymbolAbi, functionName: "symbol" as const, args: [] as const },
      { address: token, abi: erc20BalanceAllowanceAbi, functionName: "decimals" as const, args: [] as const },
      { address: token, abi: hypaTokenUriAbi, functionName: "tokenURI" as const, args: [] as const },
    ]) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const ethUsd = await loadEthUsdPrice();

  const launchByToken = new Map<
    Address,
    { bondingCurve: Address; pool: Address; graduated: boolean; creator: Address }
  >();
  for (let i = 0; i < tokenAddresses.length; i++) {
    const launch = launchRows[i];
    if (!launch || launch.status !== "success") continue;
    const launchTuple = launch.result as readonly [
      Address,
      Address,
      Address,
      Address,
      Address,
      bigint,
      boolean,
      ...unknown[],
    ];
    launchByToken.set(tokenAddresses[i], {
      bondingCurve: launchTuple[1],
      pool: launchTuple[3],
      creator: launchTuple[4],
      graduated: launchTuple[6],
    });
  }

  const bondingTokens = tokenAddresses.filter((token) => !launchByToken.get(token)?.graduated);
  const graduatedTokens = tokenAddresses.filter((token) => launchByToken.get(token)?.graduated);

  const bondingPriceRows =
    bondingTokens.length > 0
      ? await pc.multicall({
          contracts: bondingTokens.map((token) => ({
            address: launchByToken.get(token)?.bondingCurve as Address,
            abi: bondingCurveTradeAbi,
            functionName: "currentPrice" as const,
            args: [] as const,
          })) as Parameters<typeof pc.multicall>[0]["contracts"],
          allowFailure: true,
        })
      : [];
  const bondingPriceByToken = new Map<Address, bigint>();
  for (let i = 0; i < bondingTokens.length; i++) {
    const r = bondingPriceRows[i];
    if (r?.status === "success") bondingPriceByToken.set(bondingTokens[i], r.result as bigint);
  }

  const graduatedPools = graduatedTokens
    .map((token) => ({ token, pool: launchByToken.get(token)?.pool }))
    .filter((x): x is { token: Address; pool: Address } => !!x.pool);
  const poolRows =
    graduatedPools.length > 0
      ? await pc.multicall({
          contracts: graduatedPools.flatMap(({ pool }) => [
            { address: pool, abi: uniswapV2PairAbi, functionName: "getReserves" as const, args: [] as const },
            { address: pool, abi: uniswapV2PairAbi, functionName: "token0" as const, args: [] as const },
            { address: pool, abi: uniswapV2PairAbi, functionName: "token1" as const, args: [] as const },
          ]) as Parameters<typeof pc.multicall>[0]["contracts"],
          allowFailure: true,
        })
      : [];
  const dexEthPerTokenByToken = new Map<Address, number>();
  for (let i = 0; i < graduatedPools.length; i++) {
    const { token } = graduatedPools[i];
    const reserves = poolRows[i * 3];
    const token0 = poolRows[i * 3 + 1];
    const token1 = poolRows[i * 3 + 2];
    if (reserves?.status !== "success" || token0?.status !== "success" || token1?.status !== "success") continue;
    const tuple = reserves.result as readonly [bigint, bigint, number];
    const reserve0 = tuple[0];
    const reserve1 = tuple[1];
    const t0 = token0.result as Address;
    const t1 = token1.result as Address;
    const weth = deployments.contracts.WETH9 as Address;
    const decRaw = metaRows[tokenAddresses.indexOf(token) * 4 + 2];
    const tokenDecimals = decRaw?.status === "success" ? Number(decRaw.result as bigint | number) : 18;
    const wethReserve = t0.toLowerCase() === weth.toLowerCase() ? reserve0 : t1.toLowerCase() === weth.toLowerCase() ? reserve1 : BigInt(0);
    const tokenReserve = t0.toLowerCase() === token.toLowerCase() ? reserve0 : t1.toLowerCase() === token.toLowerCase() ? reserve1 : BigInt(0);
    if (wethReserve <= BigInt(0) || tokenReserve <= BigInt(0)) continue;
    const wethN = Number(formatEther(wethReserve));
    const tokenN = Number(formatUnits(tokenReserve, tokenDecimals));
    if (!Number.isFinite(wethN) || !Number.isFinite(tokenN) || tokenN <= 0) continue;
    dexEthPerTokenByToken.set(token, wethN / tokenN);
  }

  const tokenUriRows = tokenAddresses.map((_, i) => metaRows[i * 4 + 3]);
  const imageRows = await Promise.all(
    tokenUriRows.map(async (r) => {
      if (!r || r.status !== "success") return null;
      return resolveTokenImageFromTokenUri(String(r.result ?? ""));
    }),
  );

  const tokens: SearchTokenItem[] = tokenAddresses.map((token, i) => {
    const launch = launchRows[i];
    const creator =
      launch?.status === "success"
        ? ((launch.result as readonly [Address, Address, Address, Address, Address])[4] ?? token)
        : token;
    const name = metaRows[i * 4]?.status === "success" ? String(metaRows[i * 4].result ?? "Token") : "Token";
    const symbol = metaRows[i * 4 + 1]?.status === "success" ? String(metaRows[i * 4 + 1].result ?? "???") : "???";
    const launchInfo = launchByToken.get(token);
    const state = launchInfo?.graduated ? "graduated" : "bonding";
    const ethPerToken = state === "bonding"
      ? (() => {
          const p = bondingPriceByToken.get(token);
          if (!p) return null;
          const n = Number(formatEther(p));
          return Number.isFinite(n) ? n : null;
        })()
      : dexEthPerTokenByToken.get(token) ?? null;
    const priceUsd = ethUsd !== null && ethPerToken !== null ? ethUsd * ethPerToken : null;
    return {
      type: "token",
      token,
      name,
      symbol,
      creator: creator as Address,
      imageUrl: imageRows[i] ?? null,
      state,
      priceUsd: Number.isFinite(priceUsd ?? NaN) ? priceUsd : null,
      launchedAt:
        launch?.status === "success"
          ? Number(
              (launch.result as readonly [Address, Address, Address, Address, Address, bigint])[5],
            )
          : null,
      href: `/token/${token}`,
    };
  });

  const tokenMarketRows = await pc.multicall({
    contracts: tokenAddresses.map((token) => ({
      address: PREDICTION_MARKET_ADDRESS,
      abi: predictionMarketAbi,
      functionName: "getTokenMarkets" as const,
      args: [token] as const,
    })) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const marketKeyMap = new Map<string, { token: Address; tokenSymbol: string }>();
  for (let i = 0; i < tokenAddresses.length; i++) {
    const ids = tokenMarketRows[i];
    if (!ids || ids.status !== "success") continue;
    const symbol = tokens[i]?.symbol ?? "???";
    for (const id of ids.result as bigint[]) {
      marketKeyMap.set(id.toString(), { token: tokenAddresses[i], tokenSymbol: symbol });
    }
  }
  const marketIds = [...marketKeyMap.keys()].map((x) => BigInt(x));
  if (marketIds.length === 0) return { tokens, markets: [] };

  const marketRows = await pc.multicall({
    contracts: marketIds.map((id) => ({
      address: PREDICTION_MARKET_ADDRESS,
      abi: predictionMarketAbi,
      functionName: "getMarket" as const,
      args: [id] as const,
    })) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const markets: SearchMarketItem[] = [];
  for (let i = 0; i < marketIds.length; i++) {
    const row = marketRows[i];
    if (!row || row.status !== "success") continue;
    const id = marketIds[i].toString();
    const rawMarket = row.result as unknown;
    const base = marketKeyMap.get(id);
    if (!base) continue;
    const marketType = Number(getTupleField<number | bigint>(rawMarket, "marketType", 3) ?? 8);
    const status = Number(getTupleField<number | bigint>(rawMarket, "status", 4) ?? 0);
    const deadline = getTupleField<bigint>(rawMarket, "deadline", 5);
    const descriptionOnChain = String(getTupleField<string>(rawMarket, "description", 15) ?? "").trim();
    const ethTarget = getTupleField<bigint>(rawMarket, "ethTarget", 6) ?? BigInt(0);
    const multiplierX10 = getTupleField<bigint>(rawMarket, "multiplierX10", 7) ?? BigInt(0);
    const minLiquidity = getTupleField<bigint>(rawMarket, "minLiquidity", 11) ?? BigInt(0);
    const descriptionRaw =
      descriptionOnChain ||
      fallbackMarketQuestion(marketType, base.tokenSymbol, ethTarget, multiplierX10, minLiquidity);
    const description = withTickerPrefix(descriptionRaw, base.tokenSymbol);
    const deadlineMs = typeof deadline === "bigint" ? Number(deadline) * 1000 : 0;
    const byStatusEnded = status !== 0;
    const byDeadlineEnded = deadlineMs > 0 ? deadlineMs <= Date.now() : false;
    markets.push({
      type: "market",
      marketId: id,
      token: base.token,
      tokenSymbol: base.tokenSymbol,
      description,
      state: byStatusEnded || byDeadlineEnded ? "ended" : "open",
      href: `/token/${base.token}#predictions`,
    });
  }
  return { tokens, markets };
}

export function filterSearchIndex(index: SearchIndex, query: string, limit = 8): SearchIndex {
  const q = query.trim();
  if (!q) return { tokens: [], markets: [] };

  const tokenRanked = index.tokens
    .map((t) => ({
      t,
      score:
        rankTextMatch([t.symbol, t.name, t.token, t.creator], q) +
        (includesCI(t.token, q) ? 20 : 0),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);

  const marketRanked = index.markets
    .map((m) => ({
      m,
      score: rankTextMatch([m.description, m.tokenSymbol, m.marketId, m.token], q),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);

  return { tokens: tokenRanked, markets: marketRanked };
}

