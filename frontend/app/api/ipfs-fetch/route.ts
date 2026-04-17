import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Server-side IPFS proxy.
 * Races all gateways simultaneously — first successful response wins.
 *
 * Caching strategy (two layers):
 *  1. Positive in-process cache — stores the raw buffer for every successful
 *     fetch so repeat requests never hit gateways again. `next: { revalidate }`
 *     on fetch() is silently ignored when a signal is present, so we implement
 *     caching ourselves.
 *  2. Negative in-process cache — recently-failed paths skip the 10 s race.
 *
 * Both caches are process-scoped (survive across requests, reset on restart).
 * The browser/CDN layer is handled via Cache-Control headers on responses.
 */

// ── positive cache ────────────────────────────────────────────────────────────
type CacheEntry = { buf: ArrayBuffer; ct: string };
const responseCache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 300; // ~60 MB at 200 KB average per entry

// ── negative cache ────────────────────────────────────────────────────────────
const NEGATIVE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const failedPaths = new Map<string, number>(); // path → timestamp of failure

const GATEWAYS = [
  "https://gateway.lighthouse.storage/ipfs/",
  "https://cf-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://4everland.io/ipfs/",
] as const;

const GATEWAY_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;

function safeIpfsPath(raw: string | null): string | null {
  if (!raw) return null;
  const p = raw.trim().replace(/^\/+/, "");
  if (!p || p.includes("..") || p.includes("\\")) return null;
  const head = p.split("/")[0] ?? "";
  if (head.startsWith("Qm")) {
    if (!/^Qm[1-9A-HJ-NP-Za-km-z]+$/.test(head)) return null;
  } else if (/^baf[a-z2-7]+$/i.test(head)) {
    /* CIDv1 — ok */
  } else {
    return null;
  }
  return p;
}

function pathFromParams(pathParam: string | null, uriParam: string | null): string | null {
  const direct = safeIpfsPath(pathParam);
  if (direct) return direct;
  const uri = uriParam?.trim();
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return safeIpfsPath(uri.slice("ipfs://".length));
  return null;
}

async function tryGateway(base: string, path: string): Promise<Response> {
  const r = await fetch(`${base}${path}`, {
    redirect: "follow",
    headers: { Accept: "*/*" },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

const NEGATIVE_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=60, s-maxage=60",
};

const POSITIVE_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const path = pathFromParams(sp.get("path"), sp.get("uri"));
  if (!path) {
    return NextResponse.json({ error: "Missing or invalid path / uri" }, { status: 400 });
  }

  // 1. Positive cache hit — return immediately without touching any gateway
  const hit = responseCache.get(path);
  if (hit) {
    return new NextResponse(hit.buf, {
      status: 200,
      headers: { "Content-Type": hit.ct, ...POSITIVE_CACHE_HEADERS },
    });
  }

  // 2. Negative cache — skip the race for recently-failed paths
  const failedAt = failedPaths.get(path);
  if (failedAt !== undefined && Date.now() - failedAt < NEGATIVE_CACHE_TTL_MS) {
    return NextResponse.json(
      { error: "All IPFS gateways failed" },
      { status: 502, headers: NEGATIVE_CACHE_HEADERS },
    );
  }

  // 3. Race all gateways — first successful one wins
  let res: Response;
  try {
    res = await Promise.any(GATEWAYS.map(base => tryGateway(base, path)));
  } catch {
    failedPaths.set(path, Date.now());
    return NextResponse.json(
      { error: "All IPFS gateways failed" },
      { status: 502, headers: NEGATIVE_CACHE_HEADERS },
    );
  }

  const len = res.headers.get("content-length");
  if (len && Number(len) > MAX_BYTES) {
    return NextResponse.json({ error: "Content too large" }, { status: 413 });
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "Content too large" }, { status: 413 });
  }

  const ct = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";

  // Store in positive cache — evict oldest entry if at capacity
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(path, { buf, ct });

  return new NextResponse(buf, {
    status: 200,
    headers: { "Content-Type": ct, ...POSITIVE_CACHE_HEADERS },
  });
}
