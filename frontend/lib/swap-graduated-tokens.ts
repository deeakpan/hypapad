import { createPublicClient, http, type Address, zeroAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { deployments, TOKEN_FACTORY_ADDRESS } from "./deployments";
import { tokenFactoryAbi } from "./token-factory";
import { erc20BalanceAllowanceAbi } from "./abis/erc20-trade";
import { hypaTokenUriAbi } from "./abis/home-reads";

export type GraduatedSwapToken = {
  token: Address;
  pool: Address;
  symbol: string;
  name: string;
  tokenURI: string;
};

const CHAIN_ID = deployments.chainId;

function chainForDeployments() {
  if (CHAIN_ID === base.id) return base;
  if (CHAIN_ID === baseSepolia.id) return baseSepolia;
  return baseSepolia;
}

function rpcUrlForChain(): string {
  const fromEnv = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL;
  if (fromEnv) return fromEnv;
  const chain = chainForDeployments();
  return chain.rpcUrls.default.http[0];
}

/** On-chain graduated token list for swap picker (server or scripts). */
export async function loadGraduatedSwapTokens(): Promise<GraduatedSwapToken[]> {
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

  if (total === 0) return [];

  const tokenAddressCalls = Array.from({ length: total }, (_, i) => ({
    address: TOKEN_FACTORY_ADDRESS,
    abi: tokenFactoryAbi,
    functionName: "allTokens" as const,
    args: [BigInt(i)] as const,
  }));

  const addrResults = await pc.multicall({
    contracts: tokenAddressCalls as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const addresses = addrResults
    .map((r) => (r.status === "success" ? (r.result as Address) : null))
    .filter(Boolean) as Address[];

  const launchResults = await pc.multicall({
    contracts: addresses.map((addr) => ({
      address: TOKEN_FACTORY_ADDRESS,
      abi: tokenFactoryAbi,
      functionName: "launches" as const,
      args: [addr] as const,
    })) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  const graduated: { addr: Address; pool: Address }[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const r = launchResults[i];
    if (r.status !== "success") continue;
    const launch = r.result as readonly [
      Address,
      Address,
      Address,
      Address,
      Address,
      bigint,
      boolean,
      ...unknown[],
    ];
    if (!launch[6] || !launch[3] || launch[3] === zeroAddress) continue;
    graduated.push({ addr: addresses[i], pool: launch[3] });
  }

  if (graduated.length === 0) return [];

  const metaResults = await pc.multicall({
    contracts: graduated.flatMap(({ addr }) => [
      {
        address: addr,
        abi: erc20BalanceAllowanceAbi,
        functionName: "symbol" as const,
        args: [] as const,
      },
      {
        address: addr,
        abi: erc20BalanceAllowanceAbi,
        functionName: "name" as const,
        args: [] as const,
      },
      {
        address: addr,
        abi: hypaTokenUriAbi,
        functionName: "tokenURI" as const,
        args: [] as const,
      },
    ]) as Parameters<typeof pc.multicall>[0]["contracts"],
    allowFailure: true,
  });

  return graduated.map(({ addr, pool }, i) => ({
    token: addr,
    pool,
    symbol: (metaResults[i * 3]?.result as string | undefined) ?? "???",
    name: (metaResults[i * 3 + 1]?.result as string | undefined) ?? "",
    tokenURI: (metaResults[i * 3 + 2]?.result as string | undefined) ?? "",
  }));
}
