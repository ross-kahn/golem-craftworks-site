// How the shop arranges its products, the same on the pages the Worker builds and in the browser.

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
