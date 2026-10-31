const ALLOWED = new Set(["ncode.syosetu.com","novel18.syosetu.com","api.syosetu.com"]);
export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url).searchParams.get("url");
  let target;
  try { target = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
  if (target.protocol !== "https:" || !ALLOWED.has(target.hostname)) return new Response("host not allowed", { status: 403 });
  const cache = caches.default;
  const key = new Request("https://yomu-cache.internal/" + target.href);
  let hit = await cache.match(key);
  if (hit) return hit;
  const isApi = target.hostname === "api.syosetu.com";
  const r = await fetch(target.href, { headers: {
    "User-Agent": isApi ? "YomuReader/1.0 (+https://github.com/EliasWatson/yomu)" : "Mozilla/5.0 (compatible; YomuReader/1.0; personal reading proxy; +https://github.com/EliasWatson/yomu)",
    "Accept-Language": "ja", ...(target.hostname.startsWith("novel18") ? { Cookie: "over18=yes" } : {}) } });
  const body = await r.arrayBuffer();
  const ttl = isApi ? 1800 : (/\/\d+\/?$/.test(target.pathname) ? 86400 : 1800);
  const resp = new Response(body, { status: r.status, headers: {
    "Content-Type": r.headers.get("Content-Type") || "text/html; charset=utf-8",
    "Cache-Control": r.ok ? `public, max-age=${ttl}` : "no-store",
    "Access-Control-Allow-Origin": "*", "X-Upstream-Status": String(r.status) } });
  if (r.ok) waitUntil(cache.put(key, resp.clone()));
  return resp;
}
