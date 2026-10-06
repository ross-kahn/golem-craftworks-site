#!/usr/bin/env node
// One-time helper: bring Etsy listings into Square from your Etsy CSV export
// (Shop Manager > Settings > Options > Download Data > Currently for Sale Listings).
//
//   * A listing whose SKU isn't in Square becomes a new item: title, description, price and SKU,
//     with stock counted and set to 1.
//   * A listing whose SKU is already in Square updates that item's title and description.
//     Its price, stock and variations are left alone.
//   * Every other column in the export (tags, materials, ...) is saved on the item as a Square
//     custom attribute named "Etsy <column>".
//
// Safe to run twice. Dry run unless you pass --apply.
// Photos are a separate step: run import-etsy-images.ts afterwards.
//
// Usage:
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-listings.ts EtsyListingsDownload.csv                               # preview
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-listings.ts EtsyListingsDownload.csv --category="8-piece RPG Dice" --apply
// Options: --category="Name" (put every NEW item in this Square category, created if missing)
//          --location=ID (defaults to SQUARE_LOCATION_ID in worker/wrangler.toml)   --sandbox

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseCSV, norm, squareClient, postJSON } from "./shared.ts";
import { planListings, attributeFor } from "./etsy-listings.ts";
import type { ListingDetails, PlannedItem } from "./etsy-listings.ts";

// Catalog objects are sent back whole when updated, so fields this script doesn't use are kept as they came.
interface CatalogObject {
  id: string;
  type?: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    variations?: { item_variation_data?: { sku?: string } }[];
    [field: string]: unknown;
  };
  category_data?: { name?: string };
  custom_attribute_definition_data?: { key?: string };
  custom_attribute_values?: Record<string, unknown>;
  [field: string]: unknown;
}

const NEW_ITEM_STOCK = 1;
const ATTRIBUTE_MAX = 255; // Square's limit for a text custom attribute

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (name: string) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=").slice(1).join("=");
const APPLY = args.includes("--apply");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const CATEGORY = opt("category");

if (!file || !TOKEN) {
  console.error("Usage: SQUARE_ACCESS_TOKEN=... node tools/import-etsy-listings.ts <etsy-export.csv> [--category=\"Name\"] [--apply]");
  process.exit(1);
}

function locationId() {
  if (opt("location")) return opt("location");
  if (process.env.SQUARE_LOCATION_ID) return process.env.SQUARE_LOCATION_ID;
  const m = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8").match(/^SQUARE_LOCATION_ID\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("No Square location: pass --location=ID");
  return m[1];
}

const sq = squareClient({ token: TOKEN, sandbox: args.includes("--sandbox") });

async function catalog(type: string) {
  const out: CatalogObject[] = []; let cursor: string | undefined;
  do {
    const d = await sq<{ objects?: CatalogObject[]; cursor?: string }>("/v2/catalog/search", postJSON({ object_types: [type], cursor, limit: 1000 }));
    out.push(...(d.objects || [])); cursor = d.cursor;
  } while (cursor);
  return out.filter((o) => !o.is_deleted);
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const descriptionHtml = (text: string) =>
  text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\r?\n/g, "<br>")}</p>`).join("");

const attributeValues = (d: ListingDetails) => Object.fromEntries(
  Object.entries(d.metadata).map(([column, value]) => [attributeFor(column).key, { string_value: value.slice(0, ATTRIBUTE_MAX) }]));

function newItem(item: PlannedItem, n: number, categoryId: string | null) {
  return {
    type: "ITEM", id: `#item-${n}`, present_at_all_locations: true,
    custom_attribute_values: attributeValues(item),
    item_data: {
      name: item.title.slice(0, 512),
      description_html: descriptionHtml(item.description),
      product_type: "REGULAR",
      ...(categoryId ? { categories: [{ id: categoryId }], reporting_category: { id: categoryId } } : {}),
      variations: item.variations.map((v, m) => ({
        type: "ITEM_VARIATION", id: `#var-${n}-${m}`, present_at_all_locations: true,
        item_variation_data: {
          item_id: `#item-${n}`, name: v.name, ...(v.sku ? { sku: v.sku } : {}),
          pricing_type: "FIXED_PRICING", price_money: { amount: item.priceCents, currency: item.currency },
          track_inventory: true
        }
      }))
    }
  };
}

// The existing item with Etsy's title, description and metadata laid over it. Everything else stays as it was.
function updatedItem(item: CatalogObject, d: ListingDetails): CatalogObject {
  const { description: _old, description_plaintext: _derived, ...data } = item.item_data || {};
  return {
    ...item,
    custom_attribute_values: { ...(item.custom_attribute_values || {}), ...attributeValues(d) },
    item_data: { ...data, name: d.title.slice(0, 512), description_html: descriptionHtml(d.description) }
  };
}

const rows = parseCSV(readFileSync(file, "utf8"));
const location = locationId();
const existing = await catalog("ITEM");
const bySku = new Map<string, CatalogObject>();
for (const it of existing) for (const v of it.item_data?.variations || []) {
  const sku = (v.item_variation_data?.sku || "").trim();
  if (sku) bySku.set(sku, it);
}
const plan = planListings(rows, { skus: new Set(bySku.keys()), titles: new Set(existing.map((i) => norm(i.item_data?.name))) });

const columns = [...new Set([...plan.create, ...plan.update].flatMap((d) => Object.keys(d.metadata)))];
const extras = (d: ListingDetails) => (Object.keys(d.metadata).length ? `  + ${Object.keys(d.metadata).map((c) => c.toLowerCase()).join(", ")}` : "");

console.log(`${rows.length} Etsy listing(s) in the export, ${existing.length} item(s) already in Square (location ${location}).`);
console.log(`Columns in the export: ${Object.keys(rows[0] || {}).join(", ")}`);
console.log(columns.length
  ? `Saved as custom attributes: ${columns.map((c) => `"${attributeFor(c).name}"`).join(", ")}\n`
  : "No extra columns to save as custom attributes.\n");

for (const item of plan.create) {
  const v = item.variations.map((x) => `${x.name}${x.sku ? ` [${x.sku}]` : ""}`).join(", ");
  console.log(`${APPLY ? "Creating" : "Would create"}: "${item.title}"  $${(item.priceCents / 100).toFixed(2)}  ${v}  stock: ${NEW_ITEM_STOCK} each${extras(item)}`);
  item.notes.forEach((n) => console.log(`   note: ${n}`));
}
for (const u of plan.update) {
  const was = bySku.get(u.sku)!.item_data?.name || "";
  console.log(`${APPLY ? "Updating" : "Would update"} [${u.sku}]: ${was === u.title ? `"${u.title}" (title unchanged)` : `"${was}" -> "${u.title}"`}, description${extras(u)}`);
}
if (plan.skipped.length) {
  console.log(`\nLeaving ${plan.skipped.length} listing(s) alone:`);
  plan.skipped.forEach((s) => console.log(`  - ${s.title || "(untitled)"}: ${s.reason}`));
}

const total = plan.create.length + plan.update.length;
if (APPLY && total) {
  // Custom attributes need a definition before any item can carry a value.
  if (columns.length) {
    const have = new Set((await catalog("CUSTOM_ATTRIBUTE_DEFINITION")).map((d) => d.custom_attribute_definition_data?.key));
    const missing = columns.map(attributeFor).filter((a) => !have.has(a.key));
    if (missing.length) {
      await sq("/v2/catalog/batch-upsert", postJSON({
        idempotency_key: randomUUID(),
        batches: [{ objects: missing.map((a, i) => ({
          type: "CUSTOM_ATTRIBUTE_DEFINITION", id: `#attribute-${i}`, present_at_all_locations: true,
          custom_attribute_definition_data: {
            type: "STRING", name: a.name, key: a.key, allowed_object_types: ["ITEM"],
            seller_visibility: "SELLER_VISIBILITY_READ_WRITE_VALUES", app_visibility: "APP_VISIBILITY_READ_WRITE_VALUES"
          }
        })) }]
      }));
    }
  }

  let categoryId: string | null = null;
  if (CATEGORY && plan.create.length) {
    const found = (await catalog("CATEGORY")).find((c) => norm(c.category_data?.name) === norm(CATEGORY));
    categoryId = found ? found.id : (await sq<{ catalog_object: { id: string } }>("/v2/catalog/object", postJSON({
      idempotency_key: randomUUID(), object: { type: "CATEGORY", id: "#category", category_data: { name: CATEGORY } }
    }))).catalog_object.id;
  }

  const objects: object[] = [
    ...plan.create.map((item, n) => newItem(item, n, categoryId)),
    ...plan.update.map((u) => updatedItem(bySku.get(u.sku)!, u))
  ];
  const newVariationIds: string[] = [];
  for (let i = 0; i < objects.length; i += 20) {
    const res = await sq<{ id_mappings?: { client_object_id: string; object_id: string }[] }>("/v2/catalog/batch-upsert", postJSON({
      idempotency_key: randomUUID(), batches: [{ objects: objects.slice(i, i + 20) }]
    }));
    for (const m of res.id_mappings || []) if (m.client_object_id.startsWith("#var-")) newVariationIds.push(m.object_id);
  }

  const now = new Date().toISOString();
  for (let i = 0; i < newVariationIds.length; i += 100) {
    await sq("/v2/inventory/changes/batch-create", postJSON({
      idempotency_key: randomUUID(),
      changes: newVariationIds.slice(i, i + 100).map((id) => ({
        type: "PHYSICAL_COUNT",
        physical_count: { catalog_object_id: id, state: "IN_STOCK", location_id: location, quantity: String(NEW_ITEM_STOCK), occurred_at: now }
      }))
    }));
  }
  console.log(`\nCreated ${plan.create.length} item(s) with stock of ${NEW_ITEM_STOCK}, updated ${plan.update.length}.`);
  console.log("Next: copy the photos across with tools/import-etsy-images.ts.");
} else {
  console.log(`\n${plan.create.length} to create, ${plan.update.length} to update.${APPLY ? "" : " This was a preview. Run again with --apply to make the changes."}`);
}
