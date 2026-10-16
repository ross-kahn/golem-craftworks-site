// How the shop arranges its products, the same on the pages the Worker builds and in the browser.
import { group } from "radashi";
import { slugify } from "./text.ts";

// The category for anything Square has none for.
export const OTHER = "Other";

// The order categories are shown in everywhere: A to Z, with "Other" last.
export const byCategory = (a: string, b: string) =>
  Number(a === OTHER) - Number(b === OTHER) || a.localeCompare(b);

// Up to four photos for a category's tile, given each piece's photos, newest piece first:
// one from each piece, then their second photos, and so on.
export function tilePhotos(pieces: string[][]) {
  const out: string[] = [];
  for (
    let i = 0;
    out.length < 4 && pieces.some((photos) => photos.length > i);
    i++
  ) {
    for (const photos of pieces)
      if (photos[i] && out.length < 4) out.push(photos[i]);
  }
  return out;
}

// Pieces marked down in Square (an "Original price" on the item) also get a page of their own,
// shown ahead of the other categories. They stay in their own category too.
export const SALE = { name: "Sale", slug: "sale" };

interface Shelved {
  category?: string;
  originalCents?: number;
}

// The shop's categories, each with its own page at /shop/<slug>: Sale first when anything's marked
// down, then the rest in byCategory order. Products keep the order they're given in.
export function shopCategories<P extends Shelved>(products: P[]) {
  const named = (p: P) => p.category || OTHER;
  const bySlug = group(products, (p) => slugify(named(p)));
  const sale = products.filter(
    (p) => p.originalCents || slugify(named(p)) === SALE.slug,
  );
  return [
    ...(sale.length ? [{ ...SALE, products: sale }] : []),
    ...Object.entries(bySlug)
      .filter(([slug]) => slug !== SALE.slug)
      .map(([slug, list = []]) => ({
        name: named(list[0]),
        slug,
        products: list,
      }))
      .sort((a, b) => byCategory(a.name, b.name)),
  ];
}

// The price, as the shop shows it once it's formatted. Marked down: the sale price, what it was
// struck through, and how much is off.
export function priceMarkup(now: string, was?: string, off = 0) {
  if (!was || off <= 0) return now;
  return `<span class="price__now">${now}</span> <s class="price__was"><span class="visually-hidden">was </span>${was}</s> <span class="price__off">${off}% off</span>`;
}

// Whole percent off, rounded down so the shop never claims more of a discount than it gives.
// Zero when the price isn't actually lower.
export const percentOff = (originalCents: number, nowCents: number) =>
  originalCents > 0 && nowCents < originalCents
    ? Math.floor(((originalCents - nowCents) / originalCents) * 100)
    : 0;
