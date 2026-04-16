import { NextResponse } from "next/server";
import { lighthouseUploadFormData } from "../../../../lib/lighthouse-upload";

export const runtime = "nodejs";

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

  const out = new FormData();
  const name =
    typeof (file as File).name === "string" && (file as File).name
      ? (file as File).name
      : "image";
  out.append("file", file, name);

  try {
    const result = await lighthouseUploadFormData(apiKey, out);
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
