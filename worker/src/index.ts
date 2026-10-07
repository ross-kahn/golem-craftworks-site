// Golem Craftworks Worker. The website in site/ is served by Cloudflare directly; this code handles:
//   GET  /api/products          storefront catalog from Square (cached ~60s)
//   POST /api/checkout          creates a Square checkout link
//   POST /api/commission        emails a commission request to the shop + a confirmation to the client
//   GET  /product/<slug>, /shop/<slug>, /   pages built from the catalog so crawlers get the real content
//   GET  /sitemap.xml, /robots.txt, /llms.txt, /feeds/google.xml
//   POST /webhooks/square       Square inventory changes -> Etsy
//   POST /webhooks/etsy         Etsy paid orders -> Square
//   GET  /api/reviews           Etsy reviews + approved site reviews, with totals
//   POST /api/reviews           leave a review (held for approval)
//   GET  /admin/reviews         every site review (needs ?token=); each has its own approval link
//   GET  /admin/status          sync health (needs ?token=ADMIN_TOKEN)
//   GET  /admin/catalog         every Square item and why it is or isn't on the site (needs ?token=)
//   POST /admin/reconcile       run the hourly check now (needs ?token=)
//   GET  /admin/etsy/connect    one-time Etsy sign-in (needs ?token=)
//   cron (hourly)               safety check + Etsy token refresh

import * as square from "./square.ts";
import * as etsyApi from "./etsy.ts";
import { handleSquareInventoryEvent, handleEtsyEvent, reconcile } from "./sync.ts";
import { commission } from "./commission.ts";
import * as reviews from "./reviews.ts";
import * as pages from "./pages.ts";
import { json, corsHeaders, safeEqual, logEvent, errMsg } from "./util.ts";
import type { Ctx, Env, EtsyTokens, EtsyWebhookEvent, LogLine, ReconcileReport, SquareWebhookEvent, StorefrontCatalog, StorefrontProduct } from "./types.ts";

const PRODUCTS_CACHE_KEY = "https://cache.golemcraftworks.internal/products";
const PRODUCTS_TTL = 60;
const SAVED_CATALOG_MAX_AGE_MS = 15 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/products" && request.method === "GET") return withCors(await products(env, ctx, url), cors);
      if (url.pathname === "/api/checkout" && request.method === "POST") return withCors(await checkout(request, env), cors);
      if (url.pathname === "/api/commission" && request.method === "POST") return withCors(await commission(request, env), cors);
      if (url.pathname === "/api/reviews" && request.method === "GET") return withCors(await reviews.list(env, ctx), cors);
      if (url.pathname === "/api/reviews" && request.method === "POST") return withCors(await reviews.submit(request, env), cors);
      if (url.pathname.startsWith("/api/reviews/photo/") && request.method === "GET") return reviews.photo(env, url);
      if (url.pathname === "/admin/reviews" || url.pathname === "/admin/review") return reviews.moderate(request, env, url);
      if (url.pathname === "/webhooks/square" && request.method === "POST") return squareWebhook(request, env, ctx);
      if (url.pathname === "/webhooks/etsy" && request.method === "POST") return etsyWebhook(request, env, ctx);
      if (url.pathname.startsWith("/admin/")) return admin(request, env, url);
      if (request.method === "GET" && env.ASSETS) {
        const built = await builtPage(env, ctx, url);
        if (built) return built;
      }
      if (env.ASSETS) return env.ASSETS.fetch(request); // anything else is a page of the site (or its 404 page)
      if (url.pathname === "/") return json({ ok: true, service: "golem-craftworks" });
      return json({ error: "Not found" }, 404);
    } catch (e) {
      await logEvent(env, "Request failed", { path: url.pathname, error: errMsg(e) });
      return withCors(json({ error: "Something went wrong on our side. Try again in a minute." }, 500), cors);
    }
  },

  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil((async () => {
      try { await reviews.refreshEtsyReviews(env); }
      catch (e) { await logEvent(env, "Etsy reviews didn't refresh", { error: errMsg(e) }); }
      try {
        await etsyApi.etsyAccessToken(env); // keeps the 90-day refresh token alive
        await reconcile(env);
      } catch (e) {
        await logEvent(env, "Hourly check failed", { error: errMsg(e) });
      }
    })());
  }
};

function withCors(res: Response, cors: Record<string, string>) {
  const r = new Response(res.body, res);
  Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}

// ---------- Storefront ----------

// The catalog as the site sees it, cached for a minute. If Square can't be reached, the last good
// copy is used so product pages keep working.
async function catalog(env: Env, ctx: Ctx, url: URL): Promise<StorefrontCatalog> {
  // `npm run dev` with no Square token: the sample products in site/data/demo-products.json, so the
  // pages can be worked on without any secrets. DEMO_CATALOG is only ever set by that command.
  if (env.DEMO_CATALOG === "true" && !env.SQUARE_ACCESS_TOKEN && env.ASSETS) {
    const res = await env.ASSETS.fetch(new Request(new URL("/data/demo-products.json", url)));
    const demo = (await res.json()) as Pick<StorefrontCatalog, "products">;
    return { products: demo.products, generatedAt: new Date().toISOString() };
  }
  const cache = caches.default;
  const hit = await cache.match(PRODUCTS_CACHE_KEY);
  if (hit) return hit.json();
  let data: StorefrontCatalog;
  try {
    const { products } = await square.buildStorefront(env);
    // SKUs are internal; the storefront doesn't need them.
    data = { products: products.map((p) => ({ ...p, variations: p.variations.map(({ sku, ...v }) => v) })), generatedAt: new Date().toISOString() };
  } catch (e) {
    const saved = await env.GC_KV.get<StorefrontCatalog>("storefront:last", "json");
    if (!saved) throw e;
    await logEvent(env, "Square couldn't be reached; showing the last saved catalog", { savedAt: saved.generatedAt, error: errMsg(e) });
    return saved;
  }
  ctx.waitUntil((async () => {
    await cache.put(PRODUCTS_CACHE_KEY, json(data, 200, { "cache-control": `public, max-age=${PRODUCTS_TTL}` }));
    // Saved sparingly: KV allows a limited number of writes a day.
    const saved = await env.GC_KV.get<StorefrontCatalog>("storefront:last", "json");
    if (!saved || Date.now() - Date.parse(saved.generatedAt) > SAVED_CATALOG_MAX_AGE_MS) await env.GC_KV.put("storefront:last", JSON.stringify(data));
    // Remember every address a product has had, so a rename in Square redirects instead of breaking links.
    const known = (await env.GC_KV.get<Record<string, string>>(pages.ADDRESSES_KEY, "json")) || {};
    const fresh = data.products.filter((p) => known[p.slug] !== p.id);
    if (fresh.length) {
      fresh.forEach((p) => { known[p.slug] = p.id; });
      await env.GC_KV.put(pages.ADDRESSES_KEY, JSON.stringify(known));
    }
  })());
  return data;
}

async function products(env: Env, ctx: Ctx, url: URL) {
  return json(await catalog(env, ctx, url), 200, { "cache-control": `public, max-age=${PRODUCTS_TTL}` });
}

// Pages and crawler files built from the catalog (see pages.ts). Null means "serve the static file".
async function builtPage(env: Env, ctx: Ctx, url: URL) {
  const path = url.pathname;
  if (path === "/robots.txt") return pages.robots(env, url);
  if (path === "/js/config.js") return pages.siteConfig(env, url);
  if (path === "/shipping/") return pages.shippingPage(env, url);
  const isProduct = path.startsWith("/product/") && path !== "/product/";
  const isCategory = path.startsWith("/shop/") && path !== "/shop/";
  if (!isProduct && !isCategory && !["/", "/sitemap.xml", "/llms.txt", "/feeds/google.xml"].includes(path)) return null;
  let data: StorefrontCatalog;
  try { data = await catalog(env, ctx, url); }
  catch (e) {
    // The home page still works without the catalog: the browser script loads it. The rest have nothing to show.
    await logEvent(env, "Page built without the catalog", { path, error: errMsg(e) });
    if (path === "/") return null;
    data = { products: [], generatedAt: new Date().toISOString() };
  }
  if (isProduct) return pages.productPage(env, url, data);
  if (isCategory) return pages.categoryPage(env, url, data);
  if (path === "/") return pages.homePage(env, url, data);
  if (path === "/sitemap.xml") return pages.sitemap(env, url, data);
  if (path === "/llms.txt") return pages.llms(env, url, data);
  return pages.googleFeed(env, url, data);
}

const purgeProducts = () => caches.default.delete(PRODUCTS_CACHE_KEY);

interface CheckoutBody {
  lines?: { variationId?: unknown; qty?: unknown; modifiers?: unknown }[];
  fulfillment?: unknown;
}

async function checkout(request: Request, env: Env) {
  let body: CheckoutBody;
  try { body = (await request.json()) as CheckoutBody; } catch { return json({ error: "Invalid request." }, 400); }
  const raw = Array.isArray(body.lines) ? body.lines : [];
  // The same variation with different add-ons is a separate line.
  const merged = new Map<string, { variationId: string; qty: number; modifiers: string[] }>();
  for (const l of raw) {
    const qty = Math.floor(Number(l.qty));
    if (typeof l.variationId !== "string" || !(qty > 0)) continue;
    const mods = Array.isArray(l.modifiers) ? l.modifiers.filter((m): m is string => typeof m === "string") : [];
    const modifiers = [...new Set(mods)].sort();
    const key = [l.variationId, ...modifiers].join("|");
    const line = merged.get(key) || { variationId: l.variationId, qty: 0, modifiers };
    line.qty = Math.min(20, line.qty + qty);
    merged.set(key, line);
  }
  if (!merged.size || merged.size > 25) return json({ error: "Your cart is empty." }, 400);
  const fulfillment = body.fulfillment === "pickup" ? "pickup" : "ship";

  // Check against exactly what the storefront is showing: prices, stock and add-on rules.
  const { products } = await square.buildStorefront(env);
  const byVariation = new Map<string, { product: StorefrontProduct; qty: number | null }>();
  products.forEach((p) => p.variations.forEach((v) => byVariation.set(v.id, { product: p, qty: v.qty })));

  const wanted = new Map<string, number>(); // stock is per variation, whatever the add-ons
  merged.forEach((l) => wanted.set(l.variationId, (wanted.get(l.variationId) || 0) + l.qty));
  const soldOut = [...wanted].filter(([id, qty]) => {
    const hit = byVariation.get(id);
    return !hit || (hit.qty !== null && hit.qty < qty);
  }).map(([id]) => id);
  if (soldOut.length) {
    return json({ error: "Something in your cart just sold. Remove it to continue.", soldOut }, 409);
  }

  const lines = [...merged.values()];
  const changed = lines.filter((l) => !validModifiers(byVariation.get(l.variationId)!.product, l.modifiers)).map((l) => l.variationId);
  if (changed.length) {
    return json({ error: "The options on something in your cart have changed. Remove it and add it again.", changed }, 409);
  }

  const link = await square.createPaymentLink(env, { lines, fulfillment });
  return json({ url: link.url });
}

// Every chosen add-on belongs to the product, and each list has between its min and max chosen.
function validModifiers(product: StorefrontProduct, chosen: string[]) {
  const known = new Set(product.modifierLists.flatMap((l) => l.modifiers.map((m) => m.id)));
  if (chosen.some((id) => !known.has(id))) return false;
  return product.modifierLists.every((l) => {
    const n = l.modifiers.filter((m) => chosen.includes(m.id)).length;
    return n >= l.min && n <= l.max;
  });
}

// ---------- Webhooks ----------

async function squareWebhook(request: Request, env: Env, ctx: Ctx) {
  const raw = await request.text();
  if (!(await square.verifySquareSignature(env, request, raw))) return json({ error: "Bad signature" }, 401);
  const event: SquareWebhookEvent = JSON.parse(raw);
  if (event.event_id) {
    const key = `square:event:${event.event_id}`;
    if (await env.GC_KV.get(key)) return json({ ok: true, duplicate: true });
    await env.GC_KV.put(key, "1", { expirationTtl: 60 * 60 * 72 });
  }
  if (event.type === "inventory.count.updated") {
    ctx.waitUntil((async () => {
      await purgeProducts();
      try { await handleSquareInventoryEvent(env, event); }
      catch (e) { await logEvent(env, "Square webhook handling failed", { error: errMsg(e) }); }
    })());
  } else if (event.type && event.type.startsWith("catalog.")) {
    ctx.waitUntil(purgeProducts());
  }
  return json({ ok: true });
}

async function etsyWebhook(request: Request, env: Env, ctx: Ctx) {
  const raw = await request.text();
  if (!(await etsyApi.verifyEtsySignature(env, request, raw))) return json({ error: "Bad signature" }, 401);
  const event: EtsyWebhookEvent = JSON.parse(raw);
  ctx.waitUntil((async () => {
    try { await handleEtsyEvent(env, event); }
    catch (e) { await logEvent(env, "Etsy webhook handling failed (the hourly check will retry)", { error: errMsg(e) }); }
  })());
  return json({ ok: true });
}

// ---------- Admin ----------

async function admin(request: Request, env: Env, url: URL) {
  const token = url.searchParams.get("token") || "";
  const isCallback = url.pathname === "/admin/etsy/callback"; // Etsy can't pass our token; PKCE state protects it
  if (!isCallback && !(env.ADMIN_TOKEN && safeEqual(token, env.ADMIN_TOKEN))) return json({ error: "Not found" }, 404);

  const redirectUri = `${url.origin}/admin/etsy/callback`;

  if (url.pathname === "/admin/etsy/connect") {
    return Response.redirect(await etsyApi.startEtsyAuth(env, redirectUri), 302);
  }
  if (isCallback) {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return html("Etsy sign-in was cancelled.", 400);
    await etsyApi.finishEtsyAuth(env, { code, state, redirectUri });
    await logEvent(env, "Etsy connected");
    let shopLine = "";
    try {
      const me = await etsyApi.etsy<{ shop_id?: number }>(env, "/users/me");
      if (me.shop_id) shopLine = `<p>Your Etsy shop ID is <strong>${me.shop_id}</strong>. Put it in ETSY_SHOP_ID in wrangler.toml if you haven't yet.</p>`;
    } catch { /* not critical */ }
    return html(`<p>Etsy is connected. You can close this tab.</p>${shopLine}`);
  }
  if (url.pathname === "/admin/status") {
    const [last, log, tokens] = await Promise.all([
      env.GC_KV.get<ReconcileReport>("status:last-reconcile", "json"),
      env.GC_KV.get<LogLine[]>("log", "json"),
      env.GC_KV.get<EtsyTokens>("etsy:tokens", "json")
    ]);
    return json({
      etsyConnected: !!tokens,
      dryRun: env.SYNC_DRY_RUN === "true",
      lastHourlyCheck: last,
      recentActivity: log || []
    });
  }
  if (url.pathname === "/admin/catalog") {
    const report = await square.catalogReport(env);
    await env.GC_KV.put("status:catalog", JSON.stringify(report));
    return json(report);
  }
  if (url.pathname === "/admin/reconcile" && request.method === "POST") {
    return json(await reconcile(env));
  }
  return json({ error: "Not found" }, 404);
}

function html(message: string, status = 200) {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Golem Craftworks</title>` +
    `<body style="font:18px system-ui;padding:40px;max-width:40ch">${message}</body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
