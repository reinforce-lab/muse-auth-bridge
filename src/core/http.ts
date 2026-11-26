export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function errorJson(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Pass a vendor response through, keeping status and JSON body, dropping hop headers.
 *  Deliberate exception: vendor error statuses are mapped to 502.
 *  A vendor 401/403 means the *bridge's* vendor credentials were refused
 *  (bad token, daily quota, ...); a vendor 429 means the vendor is rate
 *  limiting the bridge; a vendor 5xx means the vendor itself is failing.
 *  Returning any of them unchanged would make them indistinguishable
 *  from the bridge's own 401/403/429/500, which breaks symptom-based
 *  troubleshooting. They are therefore mapped to 502 with a vendor_*
 *  code, keeping the vendor's status and body in the payload. After
 *  this mapping the rule is purely status-based: 4xx and JSON 500 are
 *  the bridge, 502 is the vendor, and a bare non-JSON 5xx can only come
 *  from the runtime around the Worker. */
export async function passthrough(res: Response): Promise<Response> {
  const text = await res.text();
  if (res.status >= 400) {
    const code =
      res.status === 401 || res.status === 403
        ? "vendor_auth_error"
        : res.status === 429
          ? "vendor_rate_limited"
          : res.status >= 500
            ? "vendor_server_error"
            : "vendor_client_error";
    const message =
      code === "vendor_auth_error"
        ? `Vendor refused the bridge's credentials (vendor status ${res.status})`
        : code === "vendor_rate_limited"
          ? "Vendor is rate limiting the bridge (vendor status 429)"
          : code === "vendor_server_error"
            ? `Vendor is failing on its side (vendor status ${res.status})`
            : `Vendor rejected the request (vendor status ${res.status})`;
    let vendorBody: unknown = text.slice(0, 500);
    try {
      vendorBody = JSON.parse(text);
    } catch {
      // keep the text slice
    }
    return json({ error: { code, message }, vendorStatus: res.status, vendorBody }, 502);
  }
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
