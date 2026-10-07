// Etsy Open API v3: OAuth (PKCE), listings, inventory, receipts, webhook verification.
import { hmacSha256Base64, base64ToBytes, base64Url, enc8, safeEqual } from "./util.ts";
import type { Env, EtsyInventory, EtsyListing, EtsyReceipt, EtsyTokens } from "./types.ts";

const API = "https://openapi.etsy.com/v3/application";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const SCOPES = "listings_r listings_w transactions_r";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

const apiKey = (env: Env) => `${env.ETSY_KEYSTRING}:${env.ETSY_SHARED_SECRET}`;

// ---------- OAuth ----------

export async function startEtsyAuth(env: Env, redirectUri: string) {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(48));
  const verifier = base64Url(verifierBytes);
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc8(verifier))));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  await env.GC_KV.put(`etsy:pkce:${state}`, verifier, { expirationTtl: 900 });
  const u = new URL("https://www.etsy.com/oauth/connect");
  u.search = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    client_id: env.ETSY_KEYSTRING,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256"
  }).toString();
  return u.toString();
}

export async function finishEtsyAuth(env: Env, { code, state, redirectUri }: { code: string; state: string; redirectUri: string }) {
  const verifier = await env.GC_KV.get(`etsy:pkce:${state}`);
  if (!verifier) throw new Error("This sign-in link expired. Start again from /admin/etsy/connect.");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: env.ETSY_KEYSTRING,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier
  });
  await saveTokens(env, tokens);
  await env.GC_KV.delete(`etsy:pkce:${state}`);
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString()
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) throw new Error(`Etsy token request failed (${res.status}) ${data.error || ""} ${data.error_description || ""}`);
  return data;
}

async function saveTokens(env: Env, t: TokenResponse) {
  const tokens: EtsyTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000
  };
  await env.GC_KV.put("etsy:tokens", JSON.stringify(tokens));
}

export async function etsyAccessToken(env: Env) {
  const t = await env.GC_KV.get<EtsyTokens>("etsy:tokens", "json");
  if (!t) throw new Error("Etsy is not connected yet. Visit /admin/etsy/connect.");
  if (Date.now() < t.expires_at - 5 * 60 * 1000) return t.access_token;
  const fresh = await tokenRequest({
    grant_type: "refresh_token",
    client_id: env.ETSY_KEYSTRING,
    refresh_token: t.refresh_token
  });
  await saveTokens(env, fresh);
  return fresh.access_token;
}

// ---------- API calls ----------

// The app key is enough for public shop data (reviews, sales count); no shop sign-in needed.
export const etsyKeyReady = (env: Env) =>
  [env.ETSY_KEYSTRING, env.ETSY_SHOP_ID, env.ETSY_SHARED_SECRET].every((v) => !!v && v !== "REPLACE_ME");

export async function etsyPublic<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(API + path, { headers: { "x-api-key": apiKey(env) } });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`Etsy GET ${path} failed (${res.status}) ${data.error || ""}`);
  return data;
}

export async function etsy<T>(
  env: Env,
  pathOrUrl: string,
  { method = "GET", json, form, file }: { method?: string; json?: unknown; form?: Record<string, string>; file?: FormData } = {}
): Promise<T> {
  const token = await etsyAccessToken(env);
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : API + pathOrUrl;
  const headers: Record<string, string> = { "x-api-key": apiKey(env), authorization: `Bearer ${token}` };
  let body: string | FormData | undefined = file; // a file upload sets its own content type
  if (json) { headers["content-type"] = "application/json"; body = JSON.stringify(json); }
  if (form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(form).toString(); }
  const res = await fetch(url, { method, headers, body });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`Etsy ${method} ${url.replace(API, "")} failed (${res.status}) ${data.error || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

// All shop listings we might need to sync, with their SKUs and quantities.
export async function fetchShopListings(env: Env, states = ["active", "inactive", "sold_out"]) {
  const out: EtsyListing[] = [];
  for (const state of states) {
    let offset = 0;
    for (;;) {
      const data = await etsy<{ results?: EtsyListing[]; count?: number }>(
        env, `/shops/${env.ETSY_SHOP_ID}/listings?state=${state}&limit=100&offset=${offset}`);
      (data.results || []).forEach((l) => out.push(l));
      offset += 100;
      if (!data.results || data.results.length < 100 || offset >= (data.count || 0)) break;
    }
  }
  return out;
}

// sku -> listing_id. Listings whose products have SKUs set in Etsy.
export function buildEtsySkuMap(listings: EtsyListing[]) {
  const map: Record<string, number> = {};
  for (const l of listings) for (const sku of l.skus || []) if (sku) map[sku.trim()] = l.listing_id;
  return map;
}

export const getListing = (env: Env, id: number) => etsy<EtsyListing>(env, `/listings/${id}`);
export const getInventory = (env: Env, id: number) => etsy<EtsyInventory>(env, `/listings/${id}/inventory`);

export const setListingState = (env: Env, id: number, state: string) =>
  etsy<EtsyListing>(env, `/shops/${env.ETSY_SHOP_ID}/listings/${id}`, { method: "PATCH", form: { state } });

// Etsy's inventory GET returns read-only fields and price objects that its PUT rejects.
export function inventoryForPut(inv: EtsyInventory, changes: Map<string, number> /* sku -> qty */) {
  // Etsy refuses the update unless every offering says how soon it ships. One that has none borrows the listing's.
  const readiness = inv.products.flatMap((p) => p.offerings || []).find((o) => o.readiness_state_id)?.readiness_state_id;
  return {
    products: inv.products.filter((p) => !p.is_deleted).map((p) => {
      const sku = (p.sku || "").trim();
      const qty = changes.get(sku);
      const has = qty !== undefined;
      return {
        sku: p.sku || "",
        property_values: (p.property_values || []).map((pv) => ({
          property_id: pv.property_id,
          value_ids: pv.value_ids,
          scale_id: pv.scale_id ?? null,
          property_name: pv.property_name,
          values: pv.values
        })),
        offerings: (p.offerings || []).filter((o) => !o.is_deleted).map((o) => ({
          price: typeof o.price === "object" ? o.price.amount / o.price.divisor : o.price,
          quantity: has ? qty : o.quantity,
          is_enabled: has ? qty > 0 : o.is_enabled,
          ...(o.readiness_state_id || readiness ? { readiness_state_id: o.readiness_state_id || readiness } : {})
        }))
      };
    }),
    price_on_property: inv.price_on_property || [],
    quantity_on_property: inv.quantity_on_property || [],
    sku_on_property: inv.sku_on_property || []
  };
}

export const putInventory = (env: Env, id: number, body: unknown) =>
  etsy<unknown>(env, `/listings/${id}/inventory`, { method: "PUT", json: body });

// A new draft listing. `form` uses Etsy's own field names; lists are comma-separated.
export const createDraftListing = (env: Env, form: Record<string, string>) =>
  etsy<EtsyListing>(env, `/shops/${env.ETSY_SHOP_ID}/listings`, { method: "POST", form });

// `overwrite` puts the photo in place of the one already at that position.
export function uploadListingImage(env: Env, id: number, image: Blob, rank: number, overwrite = false) {
  const file = new FormData();
  file.append("image", image, `photo-${rank}.jpg`);
  file.append("rank", String(rank));
  if (overwrite) file.append("overwrite", "true");
  return etsy<unknown>(env, `/shops/${env.ETSY_SHOP_ID}/listings/${id}/images`, { method: "POST", file });
}

export async function getListingImages(env: Env, id: number) {
  return (await etsy<{ results?: { listing_image_id: number; rank?: number }[] }>(env, `/listings/${id}/images`)).results || [];
}

export const deleteListingImage = (env: Env, id: number, imageId: number) =>
  etsy<unknown>(env, `/shops/${env.ETSY_SHOP_ID}/listings/${id}/images/${imageId}`, { method: "DELETE" });

export async function recentPaidReceipts(env: Env, sinceSeconds: number) {
  const data = await etsy<{ results?: EtsyReceipt[] }>(
    env, `/shops/${env.ETSY_SHOP_ID}/receipts?was_paid=true&min_created=${sinceSeconds}&limit=100`);
  return data.results || [];
}

// ---------- Webhooks ----------
// Etsy signs: base64(HMAC-SHA256(base64decode(secret without "whsec_"), id + "." + timestamp + "." + body))
export async function verifyEtsySignature(env: Env, request: Request, rawBody: string) {
  const id = request.headers.get("webhook-id");
  const ts = request.headers.get("webhook-timestamp");
  const sigHeader = request.headers.get("webhook-signature");
  if (!id || !ts || !sigHeader || !env.ETSY_WEBHOOK_SECRET) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = base64ToBytes(env.ETSY_WEBHOOK_SECRET.replace(/^whsec_/, ""));
  const expected = await hmacSha256Base64(secret, `${id}.${ts}.${rawBody}`);
  // The header may carry one or more space-separated signatures, optionally prefixed "v1,".
  return sigHeader.split(" ").some((s) => safeEqual(s.replace(/^v1,/, ""), expected));
}
