// Simple in-memory cache for API requests
// Prevents hammering the explorer with duplicate requests

const cache = new Map();
const TTL = 60_000; // 60 seconds

export async function fetchWithCache(url, options = {}) {
  const now = Date.now();
  const cached = cache.get(url);

  if (cached && now - cached.ts < TTL) {
    return cached.data;
  }

  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const data = await res.json();
  cache.set(url, { data, ts: now });
  return data;
}

export function clearCache() {
  cache.clear();
}
