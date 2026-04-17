import { NextResponse } from "next/server";
import { lighthouseUploadFormData } from "../../../../lib/lighthouse-upload";
import { warmUpCid } from "../../../../lib/ipfs-verify";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

export async function POST(req: Request) {
  const apiKey = process.env.LIGHTHOUSE_API_KEY;
  if (!apiKey?.trim()) {
    return NextResponse.json(
      { error: "Server missing LIGHTHOUSE_API_KEY" },
      { status: 501 },
    );
  }

  let incoming: FormData;
  try {
    incoming = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  const file = incoming.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  // File size check
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Image must be under 5 MB (got ${(file.size / 1024 / 1024).toFixed(1)} MB)` },
      { status: 413 },
    );
  }

  // MIME type check
  const mime = file.type?.toLowerCase() ?? "";
  if (mime && !ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { error: `Unsupported image type "${mime}". Use JPEG, PNG, GIF, WebP, SVG, or AVIF.` },
      { status: 415 },
    );
  }

  const fileName =
    typeof (file as File).name === "string" && (file as File).name
      ? (file as File).name
      : "image";

  const out = new FormData();
  out.append("file", file, fileName);

  let result: { cid: string; gatewayUrl: string };
  try {
    result = await lighthouseUploadFormData(apiKey, out);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Kick off gateway warm-up in the background — Lighthouse takes 20-40s to
  // start serving freshly uploaded content. These requests run while the user
  // signs the wallet transaction so gateways are ready by the time the tx confirms.
  warmUpCid(result.cid);

  return NextResponse.json(result);
}
