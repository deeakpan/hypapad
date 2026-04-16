import { unstable_cache } from "next/cache";
import { NextResponse } from "next/server";
import { deployments, TOKEN_FACTORY_ADDRESS } from "@/lib/deployments";
import { loadGraduatedSwapTokens } from "@/lib/swap-graduated-tokens";

export const runtime = "nodejs";

const FOUR_MIN = 240;

const getCachedGraduatedTokens = unstable_cache(
  () => loadGraduatedSwapTokens(),
  ["swap-graduated-tokens"],
  {
    revalidate: FOUR_MIN,
    tags: [
      `swap-graduated-${deployments.chainId}-${TOKEN_FACTORY_ADDRESS.toLowerCase()}`,
    ],
  },
);

export async function GET() {
  try {
    const tokens = await getCachedGraduatedTokens();
    return NextResponse.json(
      { tokens },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${FOUR_MIN}, stale-while-revalidate=${FOUR_MIN * 2}`,
        },
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
