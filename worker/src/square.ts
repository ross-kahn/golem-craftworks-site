// Square: catalog, inventory, checkout links, webhook verification.
import { hmacSha256Base64, enc8, safeEqual } from "./util.ts";
import type { Env, Fulfillment, SquareCount, SquareObject, StorefrontProduct } from "./types.ts";

const DEFAULT_VERSION = "2025-01-23";

interface SquareError {
  code: string;
  detail: string;
}

interface CatalogResponse {
  objects?: SquareObject[];
  related_objects?: SquareObject[];
  cursor?: string;
}

function base(env: Env) {
  return env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
}

export async function sq<T>(env: Env, path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(base(env) + path, {
    method,
    headers: {
      authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "square-version": env.SQUARE_VERSION || DEFAULT_VERSION,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = (await res.json().catch(() => ({}))) as T & { errors?: SquareError[] };
  if (!res.ok) {
    const detail = (data.errors || []).map((e) => `${e.code}: ${e.detail}`).join("; ");
    throw new Error(`Square ${method} ${path} failed (${res.status}) ${detail}`);
  }
  return data;
}

// ---------- Catalog ----------

// Every ITEM with its variations, images and categories (paginated).
export async function fetchCatalog(env: Env) {
  const items: SquareObject[] = [];
  const related = new Map<string, SquareObject>();
  let cursor: string | undefined;
  do {
    const data = await sq<CatalogResponse>(env, "/v2/catalog/search", {
      method: "POST",
      body: { object_types: ["ITEM"], include_related_objects: true, cursor, limit: 1000 }
    });
    (data.objects || []).forEach((o) => items.push(o));
    (data.related_objects || []).forEach((o) => related.set(o.id, o));
    cursor = data.cursor;
  } while (cursor);
  return { items, related };
}

// Current IN_STOCK counts for variation ids at our location. Returns Map(id -> number).
export async function fetchCounts(env: Env, variationIds: string[]) {
  const counts = new Map<string, number>();
  for (let i = 0; i < variationIds.length; i += 500) {
    let cursor: string | undefined;
    do {
      const data = await sq<{ counts?: SquareCount[]; cursor?: string }>(env, "/v2/inventory/counts/batch-retrieve", {
        method: "POST",
        body: {
          catalog_object_ids: variationIds.slice(i, i + 500),
          location_ids: [env.SQUARE_LOCATION_ID],
          states: ["IN_STOCK"],
          cursor
        }
      });
      (data.counts || []).forEach((c) => {
        if (c.state === "IN_STOCK" && c.location_id === env.SQUARE_LOCATION_ID) {
          counts.set(c.catalog_object_id, Math.floor(Number(c.quantity) || 0));
        }
      });
      cursor = data.cursor;
    } while (cursor);
  }
  return counts;
}

function presentHere(obj: SquareObject, locationId: string) {
  if (obj.present_at_all_locations === false) {
    return (obj.present_at_location_ids || []).includes(locationId);
  }
  return !(obj.absent_at_location_ids || []).includes(locationId);
}

function tracksInventory(variation: SquareObject, locationId: string) {
  const d = variation.item_variation_data || {};
  const override = (d.location_overrides || []).find((o) => o.location_id === locationId);
  if (override && typeof override.track_inventory === "boolean") return override.track_inventory;
  return d.track_inventory === true;
}

function categoryNames(item: SquareObject, related: Map<string, SquareObject>) {
  const d = item.item_data || {};
  const ids = (d.categories || []).map((c) => c.id);
  if (d.category_id) ids.push(d.category_id);
  if (d.reporting_category && d.reporting_category.id) ids.push(d.reporting_category.id);
  return [...new Set(ids)]
    .map((id) => related.get(id)?.category_data?.name)
    .filter((name): name is string => !!name);
}

// Shape Square's catalog into what the storefront needs. Also returns a SKU map.
export async function buildStorefront(env: Env) {
  const { items, related } = await fetchCatalog(env);
  const loc = env.SQUARE_LOCATION_ID;
  const onlineCats = (env.ONLINE_CATEGORIES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hiddenCats = (env.HIDDEN_CATEGORIES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  const candidates: { item: SquareObject; variations: SquareObject[]; cats: string[] }[] = [];
  const allVariationIds: string[] = [];
  const skuMap: Record<string, string> = {}; // sku -> variation id (all items, even hidden ones, so Etsy sales still sync)
  const tracked = new Set<string>(); // variation ids whose stock Square is counting

  for (const item of items) {
    const d = item.item_data || {};
    if (item.is_deleted || d.is_archived) continue;
    const variations = (d.variations || []).filter((v) => !v.is_deleted && presentHere(v, loc));
    variations.forEach((v) => {
      const sku = (v.item_variation_data || {}).sku;
      if (sku) skuMap[sku.trim()] = v.id;
      if (tracksInventory(v, loc)) tracked.add(v.id);
      allVariationIds.push(v.id);
    });
    if (!presentHere(item, loc)) continue;
    const cats = categoryNames(item, related);
    const lower = cats.map((c) => c.toLowerCase());
    if (onlineCats.length && !lower.some((c) => onlineCats.includes(c))) continue;
    if (hiddenCats.length && lower.some((c) => hiddenCats.includes(c))) continue;
    candidates.push({ item, variations, cats });
  }

  const counts = await fetchCounts(env, allVariationIds);
  const products: StorefrontProduct[] = [];
  for (const { item, variations, cats } of candidates) {
    const d = item.item_data || {};
    const imageIds = [...(d.image_ids || [])];
    variations.forEach((v) => (v.item_variation_data?.image_ids || []).forEach((id) => imageIds.includes(id) || imageIds.push(id)));
    const images = imageIds
      .map((id) => related.get(id)?.image_data?.url)
      .filter((url): url is string => !!url);

    const vs = variations
      .map((v) => {
        const vd = v.item_variation_data || {};
        if (!vd.price_money || vd.pricing_type === "VARIABLE_PRICING") return null; // needs a fixed price to sell online
        if (vd.sellable === false) return null;
        return {
          id: v.id,
          name: vd.name || "Default",
          sku: vd.sku || "",
          priceCents: Number(vd.price_money.amount),
          qty: tracksInventory(v, loc) ? (counts.get(v.id) ?? 0) : null
        };
      })
      .filter((v) => v !== null);
    if (!vs.length) continue;

    products.push({
      id: item.id,
      name: d.name ?? "",
      description: d.description_plaintext || stripHtml(d.description_html) || d.description || "",
      category: cats[0] || "",
      images,
      variations: vs,
      updatedAt: item.updated_at
    });
  }

  products.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { products, skuMap, counts, tracked };
}

function stripHtml(html?: string) {
  if (!html) return "";
  return html
    .replace(/<\/(p|div|li|h\d)>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export async function retrieveVariations(env: Env, ids: string[]) {
  const data = await sq<CatalogResponse>(env, "/v2/catalog/batch-retrieve", {
    method: "POST",
    body: { object_ids: ids, include_related_objects: false }
  });
  return (data.objects || []).filter((o) => o.type === "ITEM_VARIATION" && !o.is_deleted);
}

export async function findVariationBySku(env: Env, sku: string) {
  const data = await sq<CatalogResponse>(env, "/v2/catalog/search", {
    method: "POST",
    body: {
      object_types: ["ITEM_VARIATION"],
      query: { exact_query: { attribute_name: "sku", attribute_value: sku } },
      limit: 2
    }
  });
  return (data.objects || [])[0] || null;
}

// Record a sale that happened somewhere else (Etsy) against Square stock.
export async function recordExternalSale(
  env: Env,
  { variationId, quantity, idempotencyKey }: { variationId: string; quantity: number; idempotencyKey: string }
) {
  return sq<unknown>(env, "/v2/inventory/changes/batch-create", {
    method: "POST",
    body: {
      idempotency_key: idempotencyKey.slice(0, 128),
      changes: [{
        type: "ADJUSTMENT",
        adjustment: {
          catalog_object_id: variationId,
          location_id: env.SQUARE_LOCATION_ID,
          from_state: "IN_STOCK",
          to_state: "SOLD",
          quantity: String(quantity),
          occurred_at: new Date().toISOString()
        }
      }],
      ignore_unchanged_counts: true
    }
  });
}

// ---------- Checkout ----------

export async function createPaymentLink(
  env: Env,
  { lines, fulfillment }: { lines: { variationId: string; qty: number }[]; fulfillment: Fulfillment }
) {
  const ship = fulfillment !== "pickup";
  const shippingCents = Number(env.SHIPPING_FLAT_CENTS || 0);
  const site = (env.SITE_URL || "").replace(/\/$/, "");
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: lines.map((l) => ({ catalog_object_id: l.variationId, quantity: String(l.qty) })),
      pricing_options: { auto_apply_taxes: true }
    },
    checkout_options: {
      redirect_url: `${site}/thanks/`,
      ask_for_shipping_address: ship,
      allow_tipping: false,
      enable_coupon: true, // lets buyers enter codes made in Square Dashboard (Marketing > Coupons)
      ...(ship && shippingCents > 0
        ? { shipping_fee: { name: "Shipping", charge: { amount: shippingCents, currency: "USD" } } }
        : {})
    },
    payment_note: ship ? "Website order: ship" : "Website order: LOCAL PICKUP"
  };
  const data = await sq<{ payment_link: { id: string; url: string } }>(env, "/v2/online-checkout/payment-links", { method: "POST", body });
  return data.payment_link;
}

// ---------- Webhooks ----------

// Square signs: HMAC-SHA256(signature key, notification URL + raw body), base64.
export async function verifySquareSignature(env: Env, request: Request, rawBody: string) {
  const header = request.headers.get("x-square-hmacsha256-signature");
  if (!header || !env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const url = env.SQUARE_WEBHOOK_URL || request.url;
  const expected = await hmacSha256Base64(enc8(env.SQUARE_WEBHOOK_SIGNATURE_KEY), url + rawBody);
  return safeEqual(expected, header);
}
