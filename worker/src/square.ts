// Square: catalog, inventory, checkout links, webhook verification.
import { hmacSha256Base64, enc8, safeEqual, slugify } from "./util.ts";
import { diceSetName, diceSetDescription, htmlToText } from "./descriptions.ts";
import type {
  Env,
  Fulfillment,
  SquareCount,
  SquareObject,
  StorefrontModifierList,
  StorefrontProduct,
} from "./types.ts";

const DEFAULT_VERSION = "2025-05-21"; // first version with the current modifier fields (defaults, min/max)

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
  return env.SQUARE_ENV === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

export async function sq<T>(
  env: Env,
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(base(env) + path, {
    method,
    headers: {
      authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "square-version": env.SQUARE_VERSION || DEFAULT_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & {
    errors?: SquareError[];
  };
  if (!res.ok) {
    const detail = (data.errors || [])
      .map((e) => `${e.code}: ${e.detail}`)
      .join("; ");
    throw new Error(
      `Square ${method} ${path} failed (${res.status}) ${detail}`,
    );
  }
  return data;
}

// ---------- Catalog ----------

// Every ITEM with its variations, images and categories (paginated).
export async function fetchCatalog(env: Env, { includeDeleted = false } = {}) {
  const items: SquareObject[] = [];
  const related = new Map<string, SquareObject>();
  let cursor: string | undefined;
  do {
    const data = await sq<CatalogResponse>(env, "/v2/catalog/search", {
      method: "POST",
      body: {
        object_types: ["ITEM"],
        include_related_objects: true,
        include_deleted_objects: includeDeleted,
        cursor,
        limit: 1000,
      },
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
      const data = await sq<{ counts?: SquareCount[]; cursor?: string }>(
        env,
        "/v2/inventory/counts/batch-retrieve",
        {
          method: "POST",
          body: {
            catalog_object_ids: variationIds.slice(i, i + 500),
            location_ids: [env.SQUARE_LOCATION_ID],
            states: ["IN_STOCK"],
            cursor,
          },
        },
      );
      (data.counts || []).forEach((c) => {
        if (
          c.state === "IN_STOCK" &&
          c.location_id === env.SQUARE_LOCATION_ID
        ) {
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
  const override = (d.location_overrides || []).find(
    (o) => o.location_id === locationId,
  );
  if (override && typeof override.track_inventory === "boolean")
    return override.track_inventory;
  return d.track_inventory === true;
}

// "Mark as sold out" in Square. Counts as zero stock whether or not Square is counting the item.
function markedSoldOut(variation: SquareObject, locationId: string) {
  const overrides = variation.item_variation_data?.location_overrides || [];
  return overrides.some(
    (o) => o.location_id === locationId && o.sold_out === true,
  );
}

function categoryNames(item: SquareObject, related: Map<string, SquareObject>) {
  const d = item.item_data || {};
  const ids = (d.categories || []).map((c) => c.id);
  if (d.category_id) ids.push(d.category_id);
  if (d.reporting_category && d.reporting_category.id)
    ids.push(d.reporting_category.id);
  return [...new Set(ids)]
    .map((id) => related.get(id)?.category_data?.name)
    .filter((name): name is string => !!name);
}

// The modifier lists on an item ("Handmade dice +$15"), with Square's min/max rules and default selections.
// Item-level settings win over the list's own; text-entry lists are skipped.
function modifierLists(
  item: SquareObject,
  related: Map<string, SquareObject>,
  locationId: string,
) {
  const set = (n?: number) => (typeof n === "number" && n >= 0 ? n : undefined);
  const lists: StorefrontModifierList[] = [];
  const infos = [...(item.item_data?.modifier_list_info || [])].sort(
    (a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0),
  );
  for (const info of infos) {
    const list = related.get(info.modifier_list_id);
    const ld = list?.modifier_list_data;
    if (
      info.enabled === false ||
      !list ||
      !ld ||
      list.is_deleted ||
      ld.modifier_type === "TEXT"
    )
      continue;
    const overrides = new Map(
      (info.modifier_overrides || []).map((o) => [o.modifier_id, o]),
    );

    const modifiers = (ld.modifiers || [])
      .filter((m) => !m.is_deleted && presentHere(m, locationId))
      .sort(
        (a, b) =>
          (a.modifier_data?.ordinal ?? 0) - (b.modifier_data?.ordinal ?? 0),
      )
      .flatMap((m) => {
        const md = m.modifier_data || {};
        const o = overrides.get(m.id);
        const here = (md.location_overrides || []).find(
          (l) => l.location_id === locationId,
        );
        const hidden =
          o?.hidden_online_override === "YES" ||
          (o?.hidden_online_override !== "NO" && md.hidden_online === true);
        if (hidden || here?.sold_out) return [];
        const onByDefault =
          o?.on_by_default_override === "YES" ||
          o?.on_by_default === true ||
          (o?.on_by_default_override !== "NO" && md.on_by_default === true);
        return [
          {
            id: m.id,
            name: md.name || "",
            priceCents: Number(
              (here?.price_money || md.price_money)?.amount || 0,
            ),
            default: onByDefault,
          },
        ];
      });
    if (!modifiers.length) continue;

    // max 0 means no limit.
    const maxSet =
      set(info.max_selected_modifiers) ??
      set(ld.max_selected_modifiers) ??
      (ld.selection_type === "SINGLE" ? 1 : 0);
    const max =
      maxSet === 0 ? modifiers.length : Math.min(maxSet, modifiers.length);
    const min = Math.min(
      set(info.min_selected_modifiers) ?? set(ld.min_selected_modifiers) ?? 0,
      max,
    );
    let on = 0;
    modifiers.forEach((m) => {
      if (m.default && ++on > max) m.default = false;
    });
    lists.push({ id: list.id, name: ld.name || "", min, max, modifiers });
  }
  return lists;
}

// Shape Square's catalog into what the storefront needs. Also returns a SKU map.
export async function buildStorefront(env: Env) {
  const { items, related } = await fetchCatalog(env);
  const loc = env.SQUARE_LOCATION_ID;
  const onlineCats = (env.ONLINE_CATEGORIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hiddenCats = (env.HIDDEN_CATEGORIES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const candidates: {
    item: SquareObject;
    variations: SquareObject[];
    cats: string[];
  }[] = [];
  const allVariationIds: string[] = [];
  const skuMap: Record<string, string> = {}; // sku -> variation id (all items, even hidden ones, so Etsy sales still sync)
  const tracked = new Set<string>(); // variation ids whose stock Square is counting

  for (const item of items) {
    const d = item.item_data || {};
    if (item.is_deleted || d.is_archived) continue;
    const variations = (d.variations || []).filter(
      (v) => !v.is_deleted && presentHere(v, loc),
    );
    variations.forEach((v) => {
      const sku = (v.item_variation_data || {}).sku;
      if (sku) skuMap[sku.trim()] = v.id;
      if (tracksInventory(v, loc)) tracked.add(v.id);
      allVariationIds.push(v.id);
    });
    if (!presentHere(item, loc)) continue;
    const cats = categoryNames(item, related);
    const lower = cats.map((c) => c.toLowerCase());
    if (onlineCats.length && !lower.some((c) => onlineCats.includes(c)))
      continue;
    if (hiddenCats.length && lower.some((c) => hiddenCats.includes(c)))
      continue;
    candidates.push({ item, variations, cats });
  }

  const counts = await fetchCounts(env, allVariationIds);
  const products: StorefrontProduct[] = [];
  for (const { item, variations, cats } of candidates) {
    const d = item.item_data || {};
    const imageIds = [...(d.image_ids || [])];
    variations.forEach((v) =>
      (v.item_variation_data?.image_ids || []).forEach(
        (id) => imageIds.includes(id) || imageIds.push(id),
      ),
    );
    const images = imageIds
      .map((id) => related.get(id)?.image_data?.url)
      .filter((url): url is string => !!url);

    const vs = variations
      .map((v) => {
        const vd = v.item_variation_data || {};
        if (!vd.price_money || vd.pricing_type === "VARIABLE_PRICING")
          return null; // needs a fixed price to sell online
        if (vd.sellable === false) return null;
        return {
          id: v.id,
          name: vd.name || "Default",
          sku: vd.sku || "",
          priceCents: Number(vd.price_money.amount),
          qty: markedSoldOut(v, loc)
            ? 0
            : tracksInventory(v, loc)
              ? (counts.get(v.id) ?? 0)
              : null,
        };
      })
      .filter((v) => v !== null);
    if (!vs.length) continue;

    // The formatted description first: Square's plain-text copy runs every paragraph together.
    const text =
      htmlToText(d.description_html) ||
      d.description_plaintext ||
      d.description ||
      "";
    const set = diceSetName(d.name ?? "");

    products.push({
      id: item.id,
      slug: slugify(d.name ?? "") || item.id.toLowerCase(),
      name: d.name ?? "",
      // Dice sets share one description (descriptions.ts); Square's text is the set-specific part of it.
      description: set ? diceSetDescription(set, text) : text,
      category: cats[0] || "",
      images,
      variations: vs,
      modifierLists: modifierLists(item, related, loc),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    });
  }

  // Two items with the same name can't share an address: each gets the end of its Square id added.
  const taken = new Map<string, number>();
  products.forEach((p) => taken.set(p.slug, (taken.get(p.slug) || 0) + 1));
  products.forEach((p) => {
    if (taken.get(p.slug)! > 1) p.slug += `-${p.id.slice(-6).toLowerCase()}`;
  });

  // Newest pieces first, by when they were added to Square. Editing an item doesn't move it.
  const added = (p: StorefrontProduct) => p.createdAt || p.updatedAt || "";
  products.sort(
    (a, b) => added(b).localeCompare(added(a)) || a.name.localeCompare(b.name),
  );
  return { products, skuMap, counts, tracked };
}

// Every item Square knows about, deleted ones included, with why each is or isn't on the site.
// Read-only; for working out where an item went (/admin/catalog).
export async function catalogReport(env: Env) {
  const { items, related } = await fetchCatalog(env, { includeDeleted: true });
  const loc = env.SQUARE_LOCATION_ID;
  const csv = (v?: string) =>
    (v || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const onlineCats = csv(env.ONLINE_CATEGORIES),
    hiddenCats = csv(env.HIDDEN_CATEGORIES);
  const rows = items
    .map((item) => {
      const d = item.item_data || {};
      const variations = (d.variations || []).filter((v) => !v.is_deleted);
      const cats = categoryNames(item, related);
      const lower = cats.map((c) => c.toLowerCase());
      const sellable = variations.some((v) => {
        const vd = v.item_variation_data || {};
        return (
          presentHere(v, loc) &&
          vd.price_money &&
          vd.pricing_type !== "VARIABLE_PRICING" &&
          vd.sellable !== false
        );
      });
      const status = item.is_deleted
        ? "deleted in Square"
        : d.is_archived
          ? "archived in Square"
          : !presentHere(item, loc)
            ? "not at this Square location"
            : onlineCats.length && !lower.some((c) => onlineCats.includes(c))
              ? "not in an online category"
              : hiddenCats.length && lower.some((c) => hiddenCats.includes(c))
                ? "in a hidden category"
                : !sellable
                  ? "no variation with a fixed price at this location"
                  : "on the site";
      return {
        status,
        name: d.name || "",
        categories: cats,
        updatedAt: item.updated_at,
        skus: variations
          .map((v) => v.item_variation_data?.sku || "")
          .filter(Boolean),
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const totals: Record<string, number> = {};
  rows.forEach((r) => {
    totals[r.status] = (totals[r.status] || 0) + 1;
  });
  return { at: new Date().toISOString(), locationId: loc, totals, items: rows };
}

export async function retrieveVariations(env: Env, ids: string[]) {
  const data = await sq<CatalogResponse>(env, "/v2/catalog/batch-retrieve", {
    method: "POST",
    body: { object_ids: ids, include_related_objects: false },
  });
  return (data.objects || []).filter(
    (o) => o.type === "ITEM_VARIATION" && !o.is_deleted,
  );
}

export async function findVariationBySku(env: Env, sku: string) {
  const data = await sq<CatalogResponse>(env, "/v2/catalog/search", {
    method: "POST",
    body: {
      object_types: ["ITEM_VARIATION"],
      query: { exact_query: { attribute_name: "sku", attribute_value: sku } },
      limit: 2,
    },
  });
  return (data.objects || [])[0] || null;
}

// Record a sale that happened somewhere else (Etsy) against Square stock.
export async function recordExternalSale(
  env: Env,
  {
    variationId,
    quantity,
    idempotencyKey,
  }: { variationId: string; quantity: number; idempotencyKey: string },
) {
  return sq<unknown>(env, "/v2/inventory/changes/batch-create", {
    method: "POST",
    body: {
      idempotency_key: idempotencyKey.slice(0, 128),
      changes: [
        {
          type: "ADJUSTMENT",
          adjustment: {
            catalog_object_id: variationId,
            location_id: env.SQUARE_LOCATION_ID,
            from_state: "IN_STOCK",
            to_state: "SOLD",
            quantity: String(quantity),
            occurred_at: new Date().toISOString(),
          },
        },
      ],
      ignore_unchanged_counts: true,
    },
  });
}

// ---------- Sales count ----------

interface OrderLine {
  quantity?: string;
}
interface SquareOrder {
  state?: string;
  tenders?: unknown[];
  line_items?: OrderLine[];
  returns?: { return_line_items?: OrderLine[] }[];
}

// Items sold in Square (website and in person) in orders made since a date, less anything returned.
// A paid website order stays OPEN until it's marked shipped, so paid counts as sold, not only COMPLETED.
export async function itemsSoldSince(env: Env, since: string) {
  const qty = (lines?: OrderLine[]) =>
    (lines || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
  let total = 0;
  let cursor: string | undefined;
  do {
    const data = await sq<{ orders?: SquareOrder[]; cursor?: string }>(
      env,
      "/v2/orders/search",
      {
        method: "POST",
        body: {
          location_ids: [env.SQUARE_LOCATION_ID],
          query: {
            filter: {
              state_filter: { states: ["OPEN", "COMPLETED"] },
              date_time_filter: {
                created_at: { start_at: new Date(since).toISOString() },
              },
            },
          },
          limit: 500,
          cursor,
        },
      },
    );
    for (const o of data.orders || []) {
      if (o.state === "COMPLETED" || (o.tenders && o.tenders.length))
        total += qty(o.line_items);
      for (const r of o.returns || []) total -= qty(r.return_line_items);
    }
    cursor = data.cursor;
  } while (cursor);
  return Math.max(0, Math.round(total));
}

// ---------- Checkout ----------

// Starts the note on every payment made through the site, which is how a website sale is told from an in-person one (sales.ts).
export const WEBSITE_ORDER_NOTE = "Website order";

export async function createPaymentLink(
  env: Env,
  {
    lines,
    fulfillment,
  }: {
    lines: { variationId: string; qty: number; modifiers?: string[] }[];
    fulfillment: Fulfillment;
  },
) {
  const ship = fulfillment !== "pickup";
  const shippingCents = Number(env.SHIPPING_FLAT_CENTS || 0);
  const site = (env.SITE_URL || "").replace(/\/$/, "");
  const body = {
    idempotency_key: crypto.randomUUID(),
    order: {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: lines.map((l) => ({
        catalog_object_id: l.variationId,
        quantity: String(l.qty),
        ...(l.modifiers && l.modifiers.length
          ? { modifiers: l.modifiers.map((id) => ({ catalog_object_id: id })) }
          : {}),
      })),
      // Pickup is always local, so it's charged the taxes set on the items in Square. Shipped orders add
      // none: Square can't tax by destination here, most ship out of state where none is due, and on
      // Wisconsin ones the shop pays it out of the price (the order email points those out).
      pricing_options: { auto_apply_taxes: !ship },
    },
    checkout_options: {
      redirect_url: `${site}/thanks/`,
      ask_for_shipping_address: ship,
      allow_tipping: false,
      enable_coupon: true, // lets buyers enter codes made in Square Dashboard (Marketing > Coupons)
      ...(ship && shippingCents > 0
        ? {
            shipping_fee: {
              name: "Shipping",
              charge: { amount: shippingCents, currency: "USD" },
            },
          }
        : {}),
    },
    payment_note: `${WEBSITE_ORDER_NOTE}: ${ship ? "ship" : "LOCAL PICKUP"}`,
  };
  const data = await sq<{ payment_link: { id: string; url: string } }>(
    env,
    "/v2/online-checkout/payment-links",
    { method: "POST", body },
  );
  return data.payment_link;
}

// ---------- Webhooks ----------

// Square signs: HMAC-SHA256(signature key, notification URL + raw body), base64.
export async function verifySquareSignature(
  env: Env,
  request: Request,
  rawBody: string,
) {
  const header = request.headers.get("x-square-hmacsha256-signature");
  if (!header || !env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const url = env.SQUARE_WEBHOOK_URL || request.url;
  const expected = await hmacSha256Base64(
    enc8(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
    url + rawBody,
  );
  return safeEqual(expected, header);
}
