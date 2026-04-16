import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Server-side IPFS proxy.
 * Races all gateways simultaneously — first successful response wins.
 * IPFS CIDs are content-addressed and immutable, so we cache aggressively.
 */
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
    // Server-side Next.js fetch cache — CIDs never change
    next: { revalidate: 604800 },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const path = pathFromParams(sp.get("path"), sp.get("uri"));
  if (!path) {
    return NextResponse.json({ error: "Missing or invalid path / uri" }, { status: 400 });
  }

  let res: Response;
  try {
    // Race all gateways — first successful one wins
    res = await Promise.any(GATEWAYS.map(base => tryGateway(base, path)));
  } catch {
    return NextResponse.json({ error: "All IPFS gateways failed" }, { status: 502 });
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

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": ct,
      // IPFS content is immutable — browsers and CDNs can cache forever
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
