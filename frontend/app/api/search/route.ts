import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { filterSearchIndex, loadSearchIndex } from "@/lib/search-index";

export const runtime = "nodejs";

const getSearchIndexCached = unstable_cache(
  async () => loadSearchIndex(),
  ["global-search-index"],
  { revalidate: 60 },
);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();
    if (!q) return NextResponse.json({ tokens: [], markets: [] });
    const index = await getSearchIndexCached();
    const out = filterSearchIndex(index, q, 10);
    return NextResponse.json(out);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown search error";
    return NextResponse.json({ error: message, tokens: [], markets: [] }, { status: 502 });
  }
}

