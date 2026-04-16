import type { Metadata } from "next";
import { createPublicClient, http, isAddress, isAddressEqual, formatEther, zeroAddress, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { TokenTradePage } from "../../../components/token/token-trade-page";
import { deployments, TOKEN_FACTORY_ADDRESS } from "../../../lib/deployments";
import { tokenFactoryAbi } from "../../../lib/token-factory";
import { erc20NameSymbolAbi, bondingCurveReadAbi, uniswapV2PairAbi } from "../../../lib/abis/home-reads";

const WETH = deployments.contracts.WETH9 as Address;
const CHAIN_ID = deployments.chainId;

function rpcChain() {
  if (CHAIN_ID === base.id) return base;
  return baseSepolia;
}

function rpcUrl() {
  return process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? rpcChain().rpcUrls.default.http[0];
}

function fmtMc(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M mc`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(2)}K mc`;
  return `$${n.toFixed(2)} mc`;
}

async function resolveTokenMeta(address: string) {
  if (!isAddress(address)) return null;
  const token = address as Address;
  const client = createPublicClient({ chain: rpcChain(), transport: http(rpcUrl()) });

  try {
    const [nameRes, symbolRes, launchRes] = await Promise.allSettled([
      client.readContract({ address: token, abi: erc20NameSymbolAbi, functionName: "name" }),
      client.readContract({ address: token, abi: erc20NameSymbolAbi, functionName: "symbol" }),
      client.readContract({ address: TOKEN_FACTORY_ADDRESS, abi: tokenFactoryAbi, functionName: "launches", args: [token] }),
    ]);

    const name   = nameRes.status   === "fulfilled" ? (nameRes.value   as string) : null;
    const symbol = symbolRes.status === "fulfilled" ? (symbolRes.value as string) : null;
    if (!name && !symbol) return null;

    // Parse launch tuple
    const launch = launchRes.status === "fulfilled" && Array.isArray(launchRes.value)
      ? (launchRes.value as readonly unknown[])
      : null;

    const curve     = launch?.[1] as Address | undefined;
    const pool      = launch?.[3] as Address | undefined;
    const graduated = launch?.[6] as boolean | undefined;
    const hasCurve  = curve && curve !== zeroAddress;
    const hasPool   = graduated && pool && pool !== zeroAddress;

    // Fetch ETH price + reserve data in parallel
    const [ethPriceRes, reserveRes] = await Promise.allSettled([
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { next: { revalidate: 60 } })
        .then(r => r.json() as Promise<{ ethereum?: { usd?: number } }>)
        .then(d => (typeof d.ethereum?.usd === "number" ? d.ethereum.usd : null)),

      hasPool
        ? Promise.all([
            client.readContract({ address: pool!, abi: uniswapV2PairAbi, functionName: "getReserves" }),
            client.readContract({ address: pool!, abi: uniswapV2PairAbi, functionName: "token0" }),
          ])
        : hasCurve
          ? client.readContract({ address: curve!, abi: bondingCurveReadAbi, functionName: "realEthReserve" })
          : Promise.resolve(null),
    ]);

    const ethUsd = ethPriceRes.status === "fulfilled" ? ethPriceRes.value : null;
    let mcUsd: number | null = null;

    if (ethUsd && reserveRes.status === "fulfilled" && reserveRes.value !== null) {
      if (hasPool && Array.isArray(reserveRes.value)) {
        // [reserves, token0]
        const [[r0, r1], t0] = reserveRes.value as [[bigint, bigint, number], Address];
        const ethReserve = isAddressEqual(t0, WETH) ? r0 : r1;
        mcUsd = Number(formatEther(ethReserve)) * 2 * ethUsd;
      } else if (typeof reserveRes.value === "bigint") {
        mcUsd = Number(formatEther(reserveRes.value)) * ethUsd;
      }
    }

    return { name, symbol, mcUsd };
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  const meta = await resolveTokenMeta(address);

  if (!meta?.name && !meta?.symbol) {
    return { title: "Token" };
  }

  const { name, symbol, mcUsd } = meta;
  const displayName = name ?? symbol ?? "Token";
  const displaySym  = symbol ? `$${symbol}` : "";
  const mc          = mcUsd !== null ? fmtMc(mcUsd) : "";

  const titleParts  = [displayName, displaySym, mc].filter(Boolean);
  const title       = titleParts.join(" · ");
  const description = `Trade ${displayName}${displaySym ? ` (${displaySym})` : ""} on Hypapad.${mc ? ` Market cap: ${mc}.` : ""} View price, chart, and predictions.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `/token/${address}`,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return (
    <main className="min-h-screen bg-transparent pb-20">
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 sm:py-14">
        <TokenTradePage address={address} />
      </div>
    </main>
  );
}
