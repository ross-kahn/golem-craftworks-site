// How the shop arranges its products, the same on the pages the Worker builds and in the browser.
import { sum, unique } from "radashi";

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

// How many designs are in stock among some products: each in-stock value of a product's "Design"
// option (one listing can hold several, like a vault with different lids), or else one per product.
export function designCount(
  products: {
    options?: { name: string }[];
    variations: { qty?: number | null; choices?: string[] }[];
  }[],
) {
  return sum(products, (p) => {
    const inStock = p.variations.filter((v) => v.qty == null || v.qty > 0);
    const i = (p.options || []).findIndex((o) =>
      /^designs?$/i.test(o.name.trim()),
    );
    if (!inStock.length) return 0;
    return i < 0 ? 1 : unique(inStock.map((v) => v.choices?.[i])).length;
  });
}

export const designs = (n: number) => `${n} ${n === 1 ? "design" : "designs"}`;

// One combination of a product's options ("Walnut", "Dragon") and whether any is in stock.
export interface OptionCombo {
  choices: string[];
  inStock: boolean;
}

// Options are ranked: the first stands on its own, and each later one depends on the picks before it.
// A value is open when something in stock has it along with `picks` for every option ahead of `i`.
export const optionOpen = (
  combos: OptionCombo[],
  picks: string[],
  i: number,
  value: string,
) =>
  combos.some(
    (c) =>
      c.inStock &&
      c.choices[i] === value &&
      picks.slice(0, i).every((p, j) => c.choices[j] === p),
  );

// A pick for every option, after option `from` changes (-1: nothing picked yet). The picks up to it
// stay; each later option keeps its pick while that's still open, or moves to the first value that is.
export function settlePicks(
  options: { values: string[] }[],
  combos: OptionCombo[],
  picks: string[],
  from: number,
) {
  const out = picks.slice(0, from + 1);
  for (let i = from + 1; i < options.length; i++) {
    const open = options[i].values.filter((v) =>
      optionOpen(combos, out, i, v),
    );
    out.push(
      open.includes(picks[i]) ? picks[i] : open[0] || options[i].values[0],
    );
  }
  return out;
}

// How many of `picks`, from the first, a combination matches: all of them when it's the one picked.
export const leadingMatch = (choices: string[], picks: string[]) => {
  const i = picks.findIndex((p, j) => choices[j] !== p);
  return i < 0 ? picks.length : i;
};
