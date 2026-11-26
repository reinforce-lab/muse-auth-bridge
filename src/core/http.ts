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
 *  One deliberate exception: a vendor 401/403 means the *bridge's* vendor
 *  credentials were refused (bad token, daily quota, ...). Returning it
 *  unchanged would make it indistinguishable from the bridge's own 401
 *  for a bad bridge token, which breaks symptom-based troubleshooting.
 *  Vendor auth failures are therefore mapped to 502 vendor_auth_error,
 *  with the vendor's status and body preserved in the payload. */
export async function passthrough(res: Response): Promise<Response> {
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    let vendorBody: unknown = text.slice(0, 500);
    try {
      vendorBody = JSON.parse(text);
    } catch {
      // keep the text slice
    }
    return json(
      {
        error: {
          code: "vendor_auth_error",
          message: `Vendor refused the bridge's credentials (vendor status ${res.status})`,
        },
        vendorStatus: res.status,
        vendorBody,
      },
      502,
    );
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
