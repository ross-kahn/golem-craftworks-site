// Works out what each Etsy listing (a row of Etsy's CSV export) means for Square: a new item, or an
// update to the item that already carries its SKU.
// No network here, so it can be tested; import-etsy-listings.ts does the reading and writing.
import { norm } from "./shared.ts";

export interface PlannedVariation {
  name: string;
  sku: string;
}

// What Etsy says about a listing, whether the Square item is new or already there.
export interface ListingDetails {
  title: string;
  description: string;
  // Every other column of the export that has a value (tags, materials, ...), keyed by column heading.
  metadata: Record<string, string>;
}

export interface PlannedItem extends ListingDetails {
  priceCents: number;
  currency: string;
  variations: PlannedVariation[];
  notes: string[];
}

export interface PlannedUpdate extends ListingDetails {
  sku: string; // the SKU that matched an existing Square item
}

export interface Plan {
  create: PlannedItem[];
  update: PlannedUpdate[];
  skipped: { title: string; reason: string }[];
}

// Columns the import uses directly. Anything else is carried along as metadata.
const CORE = /^(TITLE|DESCRIPTION|PRICE|CURRENCY_CODE|QUANTITY|SKU|IMAGE\d+|VARIATION \d+ (TYPE|NAME|VALUES))$/;

const list = (s: string | undefined) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

export function planListings(rows: Record<string, string>[], existing: { skus: Set<string>; titles: Set<string> }): Plan {
  const plan: Plan = { create: [], update: [], skipped: [] };
  const claimed = new Set<string>(); // SKUs an earlier row has already used
  const seenTitles = new Set(existing.titles);

  for (const r of rows) {
    const title = r.TITLE || "";
    const skus = list(r.SKU);
    const skip = (reason: string) => { plan.skipped.push({ title, reason }); };
    if (!title) { skip("no title"); continue; }
    const repeat = skus.find((s) => claimed.has(s));
    if (repeat) { skip(`SKU ${repeat} is on an earlier listing in this export`); continue; }

    const details: ListingDetails = {
      title,
      description: r.DESCRIPTION || "",
      metadata: Object.fromEntries(Object.entries(r).filter(([k, v]) => v && !CORE.test(k)))
    };

    // Already in Square under this SKU: bring its details up to date, leave price and stock alone.
    const match = skus.find((s) => existing.skus.has(s));
    if (match) {
      plan.update.push({ ...details, sku: match });
      skus.forEach((s) => claimed.add(s));
      continue;
    }

    const price = Math.round(Number(r.PRICE) * 100);
    if (!(price > 0)) { skip(`no usable price ("${r.PRICE || ""}")`); continue; }
    if (seenTitles.has(norm(title))) { skip("an item with this title is already in Square under a different SKU"); continue; }

    // Etsy lists up to two options ("Wood: Walnut, Maple"). One becomes Square variations; two are combined.
    const a = list(r["VARIATION 1 VALUES"]), b = list(r["VARIATION 2 VALUES"]);
    const names = !a.length ? [] : !b.length ? a : a.flatMap((x) => b.map((y) => `${x}, ${y}`));
    const notes: string[] = [];
    let variations: PlannedVariation[];
    if (names.length > 1) {
      if (skus.length && skus.length !== names.length) notes.push(`${skus.length} SKUs for ${names.length} options: check which SKU belongs to which`);
      variations = names.map((name, i) => ({ name, sku: skus[i] || "" }));
      notes.push("prices per option aren't in Etsy's export: every option gets the listing price");
    } else {
      variations = [{ name: names[0] || "Regular", sku: skus[0] || "" }];
      if (!skus.length) notes.push("no SKU: the Etsy sync can't match this until both sides have one");
    }

    plan.create.push({ ...details, priceCents: price, currency: r.CURRENCY_CODE || "USD", variations, notes });
    skus.forEach((s) => claimed.add(s));
    seenTitles.add(norm(title));
  }
  return plan;
}

// Square custom attribute for one metadata column: "TAGS" -> key "etsy_tags", shown as "Etsy tags".
export const attributeFor = (column: string) => ({
  key: `etsy_${column.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`.slice(0, 60),
  name: `Etsy ${column.toLowerCase().replace(/_/g, " ")}`
});
