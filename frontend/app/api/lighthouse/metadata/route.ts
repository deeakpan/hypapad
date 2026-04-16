import { NextResponse } from "next/server";
import { lighthouseUploadFormData } from "../../../../lib/lighthouse-upload";

export const runtime = "nodejs";

/** ERC-20 style metadata for HypaToken / wallets (contract expects JSON with image). */
export async function POST(req: Request) {
  const apiKey = process.env.LIGHTHOUSE_API_KEY;
  if (!apiKey?.trim()) {
    return NextResponse.json(
      { error: "Server missing LIGHTHOUSE_API_KEY" },
      { status: 501 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Expected JSON object" }, { status: 400 });
  }

  const o = body as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const symbol = typeof o.symbol === "string" ? o.symbol.trim() : "";
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const imageCid = typeof o.imageCid === "string" ? o.imageCid.trim() : "";

  if (!name || !symbol || !imageCid) {
    return NextResponse.json(
      { error: "name, symbol, and imageCid are required" },
      { status: 400 },
    );
  }

  const metadata: Record<string, unknown> = {
    name,
    symbol,
    description: description || `${name} (${symbol})`,
    image: `ipfs://${imageCid}`,
  };

  const rawSocials = o.socials;
  if (rawSocials && typeof rawSocials === "object") {
    const s = rawSocials as Record<string, unknown>;
    const twitter = typeof s.twitter === "string" ? s.twitter.trim() : "";
    const telegram = typeof s.telegram === "string" ? s.telegram.trim() : "";
    const website = typeof s.website === "string" ? s.website.trim() : "";
    if (twitter) metadata.twitter = twitter;
    if (telegram) metadata.telegram = telegram;
    if (website) metadata.external_url = website;
  }

  const json = JSON.stringify(metadata);
  const blob = new Blob([json], { type: "application/json" });
  const out = new FormData();
  out.append("file", blob, "metadata.json");

  try {
    const result = await lighthouseUploadFormData(apiKey, out);
    return NextResponse.json({ ...result, metadata });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
