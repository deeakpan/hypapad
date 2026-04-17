/**
 * Gateway warm-up for freshly uploaded IPFS content.
 *
 * Lighthouse takes 20-40 s after upload before their own gateway (and others)
 * start serving a CID via GET. We can't block the launch waiting for that.
 *
 * Instead: fire non-blocking fetch requests to all gateways right after
 * upload. These run in the background while the user is signing the wallet
 * transaction (another 10-30 s). By the time the tx confirms and the homepage
 * loads, the gateways have had time to cache the content.
 */

const WARM_GATEWAYS = [
  "https://gateway.lighthouse.storage/ipfs/",
  "https://cf-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
] as const;

/**
 * Fire-and-forget: ask every gateway to fetch the CID.
 * Does not throw, does not await — caller gets control back immediately.
 */
export function warmUpCid(cid: string): void {
  for (const base of WARM_GATEWAYS) {
    void fetch(`${base}${cid}`, {
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(45_000), // long timeout — we don't care when it finishes
    })
      .then((r) => r.body?.cancel())
      .catch(() => {/* best-effort */});
  }
}
