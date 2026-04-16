/** Path after `ipfs://` (may be `CID` or `CID/path.json`). */
export function ipfsPathFromUri(uri: string): string | null {
  const t = uri.trim();
  if (!t) return null;
  if (t.startsWith("ipfs://")) {
    const path = t.slice("ipfs://".length).replace(/^\/+/, "");
    return path || null;
  }
  return null;
}

/** Same-origin proxy — avoids CORS, 504s, and dead gateways in the browser. */
export function ipfsProxyUrl(path: string): string {
  return `/api/ipfs-fetch?path=${encodeURIComponent(path)}`;
}

/**
 * Img / fetch URL for an `ipfs://…` or https URI.
 * Prefer `/api/ipfs-fetch` for IPFS so the browser never talks to public gateways directly.
 */
export function gatewayUrlsForUri(uri: string): string[] {
  const t = uri.trim();
  if (!t) return [];
  const path = ipfsPathFromUri(t);
  if (path) return [ipfsProxyUrl(path)];
  if (t.startsWith("http://") || t.startsWith("https://")) return [t];
  return [];
}

/** First URL for legacy callers (preview, etc.). */
export function ipfsUriToHttp(uri: string): string | null {
  return gatewayUrlsForUri(uri)[0] ?? null;
}

export type HypaTokenMetadata = {
  imageCandidates: string[];
  metaName?: string;
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
};

/** Fetch token JSON metadata via same-origin IPFS proxy (server tries multiple gateways). */
export async function fetchHypaTokenMetadata(tokenURI: string): Promise<HypaTokenMetadata> {
  const t = tokenURI.trim();
  if (!t) return { imageCandidates: [] };

  let parsed: unknown = null;

  const path = ipfsPathFromUri(t);
  if (path) {
    try {
      const r = await fetch(ipfsProxyUrl(path));
      if (r.ok) parsed = await r.json();
    } catch {
      /* ignore */
    }
  } else if (t.startsWith("http://") || t.startsWith("https://")) {
    try {
      const r = await fetch(t);
      if (r.ok) parsed = await r.json();
    } catch {
      /* ignore */
    }
  }

  if (!parsed || typeof parsed !== "object" || parsed === null) {
    return { imageCandidates: [] };
  }

  const obj = parsed as {
    image?: unknown;
    name?: unknown;
    description?: unknown;
    twitter?: unknown;
    telegram?: unknown;
    website?: unknown;
    external_url?: unknown;
  };
  const metaName = typeof obj.name === "string" ? obj.name : undefined;
  const description = typeof obj.description === "string" ? obj.description.trim() || undefined : undefined;
  const twitter = typeof obj.twitter === "string" ? obj.twitter : undefined;
  const telegram = typeof obj.telegram === "string" ? obj.telegram : undefined;
  const website =
    typeof obj.website === "string"
      ? obj.website
      : typeof obj.external_url === "string"
        ? obj.external_url
        : undefined;
  const rawImg = typeof obj.image === "string" ? obj.image.trim() : "";
  let imageCandidates: string[] = [];

  if (rawImg.startsWith("data:")) {
    imageCandidates = [rawImg];
  } else if (rawImg) {
    const imgPath = ipfsPathFromUri(rawImg);
    if (imgPath) {
      imageCandidates = [ipfsProxyUrl(imgPath)];
    } else if (rawImg.startsWith("http://") || rawImg.startsWith("https://")) {
      imageCandidates = [rawImg];
    }
  }

  return { imageCandidates, metaName, description, twitter, telegram, website };
}
