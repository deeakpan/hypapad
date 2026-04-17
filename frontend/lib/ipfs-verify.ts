/**
 * Verify that a CID is actually retrievable from the public IPFS network
 * before writing it on-chain.
 *
 * Uses the same multi-gateway race as the IPFS proxy, but with a Range
 * request so we only pull the first byte — enough to confirm the content
 * exists and is being served, without downloading large images.
 */

const VERIFY_GATEWAYS = [
  "https://gateway.lighthouse.storage/ipfs/",
  "https://cf-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
] as const;

async function tryGatewayGet(base: string, cid: string): Promise<void> {
  const res = await fetch(`${base}${cid}`, {
    headers: { Range: "bytes=0-0" },
    redirect: "follow",
    signal: AbortSignal.timeout(9_000),
  });
  // 200 OK (gateway ignores Range) or 206 Partial Content are both fine
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HTTP ${res.status}`);
  }
  // Cancel body immediately — we only needed the status
  await res.body?.cancel();
}

/**
 * Returns true if at least one gateway can serve the CID within the timeout.
 * Retries once after a delay to allow slow propagation from Lighthouse.
 */
export async function verifyCidAccessible(cid: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5_000));
    try {
      await Promise.any(VERIFY_GATEWAYS.map((base) => tryGatewayGet(base, cid)));
      return true;
    } catch {
      /* all gateways failed this attempt — retry */
    }
  }
  return false;
}
