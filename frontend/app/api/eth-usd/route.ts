import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Proxies CoinGecko simple price (server-side, CORS-safe). */
export async function GET() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { next: { revalidate: 60 } },
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: "CoinGecko request failed", status: res.status },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { ethereum?: { usd?: number } };
    const usd = data.ethereum?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd)) {
      return NextResponse.json({ error: "Invalid CoinGecko payload" }, { status: 502 });
    }
    return NextResponse.json({ usd });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
