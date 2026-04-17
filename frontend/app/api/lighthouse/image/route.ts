import { NextResponse } from "next/server";
import { lighthouseUploadFormData } from "../../../../lib/lighthouse-upload";
import { verifyCidAccessible } from "../../../../lib/ipfs-verify";

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

  // Verify the content is actually accessible before telling the client it's ready
  const ok = await verifyCidAccessible(result.cid);
  if (!ok) {
    return NextResponse.json(
      {
        error:
          "Image was uploaded but isn't serving from the IPFS gateway yet. " +
          "Please wait a few seconds and try again.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json(result);
}
