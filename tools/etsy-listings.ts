// Works out what each Etsy listing (a row of Etsy's CSV export) means for Square: a new item, or an
// update to the item that already carries its SKU.
// No network here, so it can be tested; import-etsy-listings.ts does the reading and writing.
import { norm } from "./shared.ts";
import { csvList as list } from "../shared/text.ts";

export interface PlannedVariation {
  name: string;
  sku: string;
}

// What Etsy says about a listing, whether the Square item is new or already there.
export interface ListingDetails {
  // The name for the Square item: the short dice-set form where there is one, otherwise Etsy's title.
  title: string;
  description: string;
  // Etsy's own title, plus every other column of the export that has a value (tags, materials, ...),
  // keyed by column heading.
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
  keepTitle: boolean; // not a dice set: the name it already has in Square stays
}

export interface Plan {
  create: PlannedItem[];
  update: PlannedUpdate[];
  skipped: { title: string; reason: string }[];
}

// The set name a dice title opens with, in capitals: "WILD MAGIC Handmade Dice – 8 Piece…" -> "WILD MAGIC".
export function setName(title: string): string | null {
  const words: string[] = [];
  for (const w of title.trim().split(/\s+/)) {
    if (!/^[A-Z0-9][A-Z0-9'’&.-]*$/.test(w) || !/[A-Z]/.test(w)) break;
    words.push(w);
  }
  const name = words.join(" ");
  return name.length > 1 ? name : null;
}

// The standard Square name for a dice set: `"WILD MAGIC" TTRPG Dice Set`. Null for anything else,
// including a title that's already in this form.
export function diceSetTitle(title: string): string | null {
  const name = setName(title);
  return name && /\bdice\b/i.test(title) ? `"${name}" TTRPG Dice Set` : null;
}

// Columns the import uses directly. Anything else is carried along as metadata.
const CORE =
  /^(DESCRIPTION|PRICE|CURRENCY_CODE|QUANTITY|SKU|IMAGE\d+|VARIATION \d+ (TYPE|NAME|VALUES))$/;

export function planListings(
  rows: Record<string, string>[],
  existing: { skus: Set<string>; titles: Set<string> },
): Plan {
  const plan: Plan = { create: [], update: [], skipped: [] };
  const claimed = new Set<string>(); // SKUs an earlier row has already used
  // SKUs are compared without regard to case: "yahtzee-walnut" on Etsy is "YAHTZEE-WALNUT" in Square.
  const inSquare = new Map([...existing.skus].map((s) => [s.toLowerCase(), s]));
  const seenTitles = new Set(existing.titles);

  for (const r of rows) {
    const etsyTitle = r.TITLE || "";
    const short = diceSetTitle(etsyTitle);
    const title = short || etsyTitle;
    const skus = list(r.SKU);
    const skip = (reason: string) => {
      plan.skipped.push({ title, reason });
    };
    if (!title) {
      skip("no title");
      continue;
    }
    const repeat = skus.find((s) => claimed.has(s.toLowerCase()));
    if (repeat) {
      skip(`SKU ${repeat} is on an earlier listing in this export`);
      continue;
    }

    const details: ListingDetails = {
      title,
      description: r.DESCRIPTION || "",
      metadata: Object.fromEntries(
        Object.entries(r).filter(([k, v]) => v && !CORE.test(k)),
      ),
    };

    // Already in Square under this SKU: bring its details up to date, leave price and stock alone.
    const match = skus.find((s) => inSquare.has(s.toLowerCase()));
    if (match) {
      plan.update.push({
        ...details,
        sku: inSquare.get(match.toLowerCase())!,
        keepTitle: !short,
      });
      skus.forEach((s) => claimed.add(s.toLowerCase()));
      continue;
    }

    const price = Math.round(Number(r.PRICE) * 100);
    if (!(price > 0)) {
      skip(`no usable price ("${r.PRICE || ""}")`);
      continue;
    }
    if (seenTitles.has(norm(title)) || seenTitles.has(norm(etsyTitle))) {
      skip(
        "an item with this title is already in Square under a different SKU",
      );
      continue;
    }

    // Etsy lists up to two options ("Wood: Walnut, Maple"). One becomes Square variations; two are combined.
    const a = list(r["VARIATION 1 VALUES"]),
      b = list(r["VARIATION 2 VALUES"]);
    const names = !a.length
      ? []
      : !b.length
        ? a
        : a.flatMap((x) => b.map((y) => `${x}, ${y}`));
    const notes: string[] = [];
    let variations: PlannedVariation[];
    if (names.length > 1) {
      // Only pair SKUs with options when they line up one to one; otherwise any pairing would be a guess.
      const paired = skus.length === names.length;
      if (skus.length && !paired)
        notes.push(
          `${skus.length} SKUs (${skus.join(", ")}) for ${names.length} options: left off, add them in Square`,
        );
      variations = names.map((name, i) => ({
        name,
        sku: paired ? skus[i] : "",
      }));
      notes.push(
        "prices per option aren't in Etsy's export: every option gets the listing price",
      );
    } else {
      variations = [{ name: names[0] || "Regular", sku: skus[0] || "" }];
      if (!skus.length)
        notes.push(
          "no SKU: the Etsy sync can't match this until both sides have one",
        );
    }

    plan.create.push({
      ...details,
      priceCents: price,
      currency: r.CURRENCY_CODE || "USD",
      variations,
      notes,
    });
    skus.forEach((s) => claimed.add(s.toLowerCase()));
    seenTitles.add(norm(title));
  }
  return plan;
}

// Square custom attribute for one metadata column: "TAGS" -> key "etsy_tags", shown as "Etsy tags".
export const attributeFor = (column: string) => ({
  key: `etsy_${column
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`.slice(0, 60),
  name: `Etsy ${column.toLowerCase().replace(/_/g, " ")}`,
});
