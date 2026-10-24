// Password gate for the whole site (HTTP Basic auth). The password lives in the
// Pages secret SITE_PASSWORD, never in the repository.
export async function onRequest({ request, env, next }) {
  const expected = env.SITE_PASSWORD;
  if (!expected) return new Response("Site locked", { status: 503 });
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = atob(header.slice(6)); } catch {}
    const password = decoded.slice(decoded.indexOf(":") + 1);
    if (await same(password, expected)) {
      const response = await next();
      const out = new Response(response.body, response);
      out.headers.set("X-Robots-Tag", "noindex, nofollow");
      out.headers.set("Cache-Control", "private, no-store");
      return out;
    }
  }
  return new Response("Password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="identit.ee", charset="UTF-8"', "Cache-Control": "no-store" },
  });
}

// Constant-time comparison through SHA-256 digests.
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
