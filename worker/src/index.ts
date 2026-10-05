// Golem Craftworks Worker. The website in site/ is served by Cloudflare directly; this code handles:
//   GET  /api/products          storefront catalog from Square (cached ~60s)
//   POST /api/checkout          creates a Square checkout link
//   POST /api/commission        emails a commission request to the shop + a confirmation to the client
//   POST /webhooks/square       Square inventory changes -> Etsy
//   POST /webhooks/etsy         Etsy paid orders -> Square
//   GET  /admin/status          sync health (needs ?token=ADMIN_TOKEN)
//   POST /admin/reconcile       run the hourly check now (needs ?token=)
//   GET  /admin/etsy/connect    one-time Etsy sign-in (needs ?token=)
//   cron (hourly)               safety check + Etsy token refresh

import * as square from "./square.ts";
import * as etsyApi from "./etsy.ts";
import { handleSquareInventoryEvent, handleEtsyEvent, reconcile } from "./sync.ts";
import { commission } from "./commission.ts";
import { json, corsHeaders, safeEqual, logEvent, errMsg } from "./util.ts";
import type { Ctx, Env, EtsyTokens, EtsyWebhookEvent, LogLine, ReconcileReport, SquareWebhookEvent } from "./types.ts";

const PRODUCTS_CACHE_KEY = "https://cache.golemcraftworks.internal/products";
const PRODUCTS_TTL = 60;

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/products" && request.method === "GET") return withCors(await products(env, ctx), cors);
      if (url.pathname === "/api/checkout" && request.method === "POST") return withCors(await checkout(request, env), cors);
      if (url.pathname === "/api/commission" && request.method === "POST") return withCors(await commission(request, env), cors);
      if (url.pathname === "/webhooks/square" && request.method === "POST") return squareWebhook(request, env, ctx);
      if (url.pathname === "/webhooks/etsy" && request.method === "POST") return etsyWebhook(request, env, ctx);
      if (url.pathname.startsWith("/admin/")) return admin(request, env, url);
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

async function products(env: Env, ctx: Ctx) {
  const cache = caches.default;
  const hit = await cache.match(PRODUCTS_CACHE_KEY);
  if (hit) return hit;
  const { products } = await square.buildStorefront(env);
  // SKUs are internal; the storefront doesn't need them.
  const publicProducts = products.map((p) => ({ ...p, variations: p.variations.map(({ sku, ...v }) => v) }));
  const res = json({ products: publicProducts, generatedAt: new Date().toISOString() }, 200, {
    "cache-control": `public, max-age=${PRODUCTS_TTL}`
  });
  ctx.waitUntil(cache.put(PRODUCTS_CACHE_KEY, res.clone()));
  return res;
}

const purgeProducts = () => caches.default.delete(PRODUCTS_CACHE_KEY);

interface CheckoutBody {
  lines?: { variationId?: unknown; qty?: unknown }[];
  fulfillment?: unknown;
}

async function checkout(request: Request, env: Env) {
  let body: CheckoutBody;
  try { body = (await request.json()) as CheckoutBody; } catch { return json({ error: "Invalid request." }, 400); }
  const raw = Array.isArray(body.lines) ? body.lines : [];
  const merged = new Map<string, number>();
  for (const l of raw) {
    const qty = Math.floor(Number(l.qty));
    if (typeof l.variationId !== "string" || !(qty > 0)) continue;
    merged.set(l.variationId, Math.min(20, (merged.get(l.variationId) || 0) + qty));
  }
  if (!merged.size || merged.size > 25) return json({ error: "Your cart is empty." }, 400);
  const fulfillment = body.fulfillment === "pickup" ? "pickup" : "ship";

  const ids = [...merged.keys()];
  const variations = await square.retrieveVariations(env, ids);
  const found = new Map(variations.map((v) => [v.id, v]));
  const counts = await square.fetchCounts(env, ids);

  const soldOut: string[] = [];
  const lines: { variationId: string; qty: number }[] = [];
  for (const [id, qty] of merged) {
    const v = found.get(id);
    const d = v && v.item_variation_data;
    if (!v || !d || !d.price_money || d.sellable === false) { soldOut.push(id); continue; }
    const override = (d.location_overrides || []).find((o) => o.location_id === env.SQUARE_LOCATION_ID);
    const tracked = override && typeof override.track_inventory === "boolean" ? override.track_inventory : d.track_inventory === true;
    if (tracked) {
      const available = counts.get(id) ?? 0;
      if (available < qty) { soldOut.push(id); continue; }
    }
    lines.push({ variationId: id, qty });
  }
  if (soldOut.length) {
    return json({ error: "Something in your cart just sold. Remove it to continue.", soldOut }, 409);
  }

  const link = await square.createPaymentLink(env, { lines, fulfillment });
  return json({ url: link.url });
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
