#!/usr/bin/env node
// One-time helper: copy product photos from your Etsy CSV export into Square,
// so Square holds the photos the website shows.
//
// Matches each Etsy row to a Square item by SKU first, then by exact title.
// Skips Square items that already have photos. Dry run unless you pass --apply.
//
// Usage:
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv            # preview
//   SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv --apply    # upload
// Options: --max-images=5   --sandbox   --include-items-with-photos

import { readFileSync } from "node:fs";
import { parseCSV, norm, squareClient, searchCatalog } from "./shared.ts";
import { csvList } from "../shared/text.ts";

// The parts of a Square catalog item this script reads.
interface SquareItem {
  id: string;
  is_deleted?: boolean;
  item_data: {
    name: string;
    is_archived?: boolean;
    image_ids?: string[];
    variations?: { item_variation_data?: { sku?: string } }[];
  };
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const APPLY = args.includes("--apply");
const SANDBOX = args.includes("--sandbox");
const INCLUDE_WITH_PHOTOS = args.includes("--include-items-with-photos");
const MAX = Number(
  (args.find((a) => a.startsWith("--max-images=")) || "=5").split("=")[1],
);
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

if (!file || !TOKEN) {
  console.error(
    "Usage: SQUARE_ACCESS_TOKEN=... node tools/import-etsy-images.ts <etsy-export.csv> [--apply]",
  );
  process.exit(1);
}

const sq = squareClient({ token: TOKEN, sandbox: SANDBOX });

async function uploadImage(
  itemId: string,
  url: string,
  name: string,
  isPrimary: boolean,
) {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`download failed ${img.status}`);
  const type = img.headers.get("content-type") || "image/jpeg";
  const blob = new Blob([await img.arrayBuffer()], { type });
  const form = new FormData();
  form.append(
    "request",
    new Blob(
      [
        JSON.stringify({
          idempotency_key: `etsy-img-${itemId}-${Buffer.from(url).toString("base64url").slice(-40)}`,
          object_id: itemId,
          is_primary: isPrimary,
          image: { type: "IMAGE", id: "#etsy_image", image_data: { name } },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.append(
    "image_file",
    blob,
    url.split("/").pop()!.split("?")[0] || "photo.jpg",
  );
  return sq("/v2/catalog/images", { method: "POST", body: form });
}

const rows = parseCSV(readFileSync(file, "utf8"));
const items = (await searchCatalog<SquareItem>(sq, "ITEM")).filter(
  (i) => !i.item_data?.is_archived,
);
const bySku = new Map<string, SquareItem>();
const byTitle = new Map<string, SquareItem>();
for (const it of items) {
  byTitle.set(norm(it.item_data.name), it);
  for (const v of it.item_data.variations || []) {
    const sku = v.item_variation_data?.sku;
    if (sku) bySku.set(sku.trim(), it);
  }
}

let planned = 0;
const unmatched: string[] = [];
const skippedHasPhotos: string[] = [];
for (const r of rows) {
  const skus = csvList(r.SKU);
  const item =
    skus.map((s) => bySku.get(s)).find(Boolean) || byTitle.get(norm(r.TITLE));
  if (!item) {
    unmatched.push(r.TITLE);
    continue;
  }
  if ((item.item_data.image_ids || []).length && !INCLUDE_WITH_PHOTOS) {
    skippedHasPhotos.push(item.item_data.name);
    continue;
  }
  const urls = Array.from({ length: 10 }, (_, i) => r[`IMAGE${i + 1}`])
    .filter(Boolean)
    .slice(0, MAX);
  if (!urls.length) continue;
  console.log(
    `${APPLY ? "Uploading" : "Would upload"} ${urls.length} photo(s): "${r.TITLE}" -> Square "${item.item_data.name}"`,
  );
  for (const [i, u] of urls.entries()) {
    planned++;
    if (!APPLY) continue;
    try {
      await uploadImage(item.id, u, `${item.item_data.name} ${i + 1}`, i === 0);
    } catch (e) {
      console.log(`   ! ${u}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

console.log(`\n${APPLY ? "Uploaded" : "Would upload"} ${planned} photo(s).`);
if (skippedHasPhotos.length)
  console.log(
    `Skipped ${skippedHasPhotos.length} Square item(s) that already have photos.`,
  );
if (unmatched.length) {
  console.log(
    `\nNo Square match for ${unmatched.length} Etsy listing(s). Give them matching SKUs or titles:`,
  );
  unmatched.forEach((t) => console.log("  - " + t));
}
if (!APPLY)
  console.log("\nThis was a preview. Run again with --apply to upload.");
