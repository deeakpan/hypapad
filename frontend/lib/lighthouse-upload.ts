const LIGHTHOUSE_ADD = "https://upload.lighthouse.storage/api/v0/add";

export type LighthouseCidResult = { cid: string; gatewayUrl: string };

function gatewayUrl(cid: string) {
  return `https://gateway.lighthouse.storage/ipfs/${cid}`;
}

/** Parse Lighthouse / IPFS add JSON (shape varies slightly). */
export function parseAddJsonResponse(body: unknown): string {
  const pick = (o: Record<string, unknown>): string | undefined => {
    const h = o.Hash ?? o.hash;
    return typeof h === "string" ? h : undefined;
  };
  if (Array.isArray(body) && body[0] && typeof body[0] === "object") {
    const cid = pick(body[0] as Record<string, unknown>);
    if (cid) return cid;
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (o.data && typeof o.data === "object") {
      const cid = pick(o.data as Record<string, unknown>);
      if (cid) return cid;
    }
    const cid = pick(o);
    if (cid) return cid;
  }
  throw new Error("Unexpected Lighthouse response shape");
}

export async function lighthouseUploadFormData(
  apiKey: string,
  formData: FormData,
): Promise<LighthouseCidResult> {
  const res = await fetch(LIGHTHOUSE_ADD, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(text || `Lighthouse upload failed (${res.status})`);
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : text;
    throw new Error(msg || `Lighthouse upload failed (${res.status})`);
  }
  const cid = parseAddJsonResponse(parsed);
  return { cid, gatewayUrl: gatewayUrl(cid) };
}
