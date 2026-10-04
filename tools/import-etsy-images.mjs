#!/usr/bin/env node
// One-time helper: copy product photos from your Etsy CSV export into Square,
// so Square holds the photos the website shows.
//
// Matches each Etsy row to a Square item by SKU first, then by exact title.
// Skips Square items that already have photos. Dry run unless you pass --apply.
//
// Usage:
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.mjs EtsyListingsDownload.csv            # preview
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.mjs EtsyListingsDownload.csv --apply    # upload
// Options: --max-images=5   --sandbox   --include-items-with-photos

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const APPLY = args.includes("--apply");
const SANDBOX = args.includes("--sandbox");
const INCLUDE_WITH_PHOTOS = args.includes("--include-items-with-photos");
const MAX = Number((args.find((a) => a.startsWith("--max-images=")) || "=5").split("=")[1]);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const BASE = SANDBOX ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
const VERSION = process.env.SQUARE_VERSION || "2025-01-23";

if (!file || !TOKEN) {
  console.error("Usage: SQUARE_ACCESS_TOKEN=... node tools/import-etsy-images.mjs <etsy-export.csv> [--apply]");
  process.exit(1);
}

// Minimal RFC 4180 CSV parser (handles quotes, commas and newlines inside fields).
function parseCSV(text) {
  const rows = []; let row = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const keys = head.map((h) => h.trim().toUpperCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || "").trim()])));
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function sq(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "square-version": VERSION, ...(init.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data.errors || data)}`);
  return data;
}

async function squareItems() {
  const items = []; let cursor;
  do {
    const d = await sq("/v2/catalog/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ object_types: ["ITEM"], cursor, limit: 1000 })
    });
    items.push(...(d.objects || [])); cursor = d.cursor;
  } while (cursor);
  return items.filter((i) => !i.is_deleted && !i.item_data?.is_archived);
}

async function uploadImage(itemId, url, name, isPrimary) {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`download failed ${img.status}`);
  const type = img.headers.get("content-type") || "image/jpeg";
  const blob = new Blob([await img.arrayBuffer()], { type });
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({
    idempotency_key: `etsy-img-${itemId}-${Buffer.from(url).toString("base64url").slice(-40)}`,
    object_id: itemId,
    is_primary: isPrimary,
    image: { type: "IMAGE", id: "#etsy_image", image_data: { name } }
  })], { type: "application/json" }));
  form.append("image_file", blob, url.split("/").pop().split("?")[0] || "photo.jpg");
  return sq("/v2/catalog/images", { method: "POST", body: form });
}

const rows = parseCSV(readFileSync(file, "utf8"));
const items = await squareItems();
const bySku = new Map(); const byTitle = new Map();
for (const it of items) {
  byTitle.set(norm(it.item_data.name), it);
  for (const v of it.item_data.variations || []) {
    const sku = v.item_variation_data?.sku; if (sku) bySku.set(sku.trim(), it);
  }
}

let planned = 0; const unmatched = []; const skippedHasPhotos = [];
for (const r of rows) {
  const skus = (r.SKU || "").split(",").map((s) => s.trim()).filter(Boolean);
  const item = skus.map((s) => bySku.get(s)).find(Boolean) || byTitle.get(norm(r.TITLE));
  if (!item) { unmatched.push(r.TITLE); continue; }
  if ((item.item_data.image_ids || []).length && !INCLUDE_WITH_PHOTOS) { skippedHasPhotos.push(item.item_data.name); continue; }
  const urls = Array.from({ length: 10 }, (_, i) => r[`IMAGE${i + 1}`]).filter(Boolean).slice(0, MAX);
  if (!urls.length) continue;
  console.log(`${APPLY ? "Uploading" : "Would upload"} ${urls.length} photo(s): "${r.TITLE}" -> Square "${item.item_data.name}"`);
  for (const [i, u] of urls.entries()) {
    planned++;
    if (!APPLY) continue;
    try { await uploadImage(item.id, u, `${item.item_data.name} ${i + 1}`, i === 0); }
    catch (e) { console.log(`   ! ${u}: ${e.message}`); }
  }
}

console.log(`\n${APPLY ? "Uploaded" : "Would upload"} ${planned} photo(s).`);
if (skippedHasPhotos.length) console.log(`Skipped ${skippedHasPhotos.length} Square item(s) that already have photos.`);
if (unmatched.length) {
  console.log(`\nNo Square match for ${unmatched.length} Etsy listing(s). Give them matching SKUs or titles:`);
  unmatched.forEach((t) => console.log("  - " + t));
}
if (!APPLY) console.log("\nThis was a preview. Run again with --apply to upload.");
