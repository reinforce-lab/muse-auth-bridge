export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Pass a vendor response through, keeping status and JSON body, dropping hop headers. */
export async function passthrough(res: Response): Promise<Response> {
  const text = await res.text();
  const headers: Record<string, string> = {
    "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8",
  };
  try {
    JSON.parse(text);
    return new Response(text, { status: res.status, headers });
  } catch {
    return json(
      { error: { code: "vendor_non_json", message: "Vendor returned a non-JSON response" }, vendorStatus: res.status, body: text.slice(0, 500) },
      res.status >= 400 ? res.status : 502,
    );
  }
}
