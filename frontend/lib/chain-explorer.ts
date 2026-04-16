import { deployments } from "./deployments";

/** Block explorer base URL for the deployment chain (addresses + txs). */
export function getExplorerBaseUrl(chainId: number = deployments.chainId): string | null {
  if (chainId === 84532) return "https://sepolia.basescan.org";
  if (chainId === 8453) return "https://basescan.org";
  if (chainId === 1) return "https://etherscan.io";
  return null;
}

export function explorerAddressUrl(
  address: string,
  chainId: number = deployments.chainId,
): string | null {
  const base = getExplorerBaseUrl(chainId);
  if (!base) return null;
  return `${base}/address/${address}`;
}

export function explorerTxUrl(hash: string, chainId: number = deployments.chainId): string | null {
  const base = getExplorerBaseUrl(chainId);
  if (!base) return null;
  return `${base}/tx/${hash}`;
}
