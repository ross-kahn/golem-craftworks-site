// Sizes the photos of past commissions for the site. The originals, straight off the camera, go in
// commission-photos/<piece>/; each becomes a full-size copy and a thumbnail under
// site/assets/commissions/<piece>/. Run by `npm run build` (see build-commission-photos.ts).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";
import { unique } from "radashi";
import { slugify } from "../shared/text.ts";

const FULL_PX = 1600; // longest side of the photo on a piece's page
const THUMB_PX = 640; // and of the one in a grid or the strip under the big picture
const READABLE = /\.(jpe?g|png|webp|avif|tiff?|gif)$/i;
const IGNORED = /^(\.|thumbs\.db$|desktop\.ini$)/i; // files Windows and macOS leave in folders

// 2 before 10, so photos numbered without leading zeros still come out in order.
const inOrder = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

const list = (dir: string, folders: boolean) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() === folders)
        .map((e) => e.name)
        .sort(inOrder)
    : [];

// Each copy carries its original's date, so a photo is only sized again when it's replaced.
function upToDate(original: string, copy: string) {
  if (!existsSync(copy)) return false;
  return (
    Math.abs(statSync(original).mtimeMs - statSync(copy).mtimeMs) < 2000 // some disks keep dates to 2 seconds
  );
}

async function size(original: string, copy: string, px: number) {
  if (upToDate(original, copy)) return false;
  await sharp(original)
    .rotate() // turned the way the camera was held; the copy drops that note along with where it was taken
    .resize({
      width: px,
      height: px,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(copy);
  const { mtime } = statSync(original);
  utimesSync(copy, mtime, mtime);
  return true;
}

// Brings `to` in line with the originals in `from`. A piece with no originals here (another computer,
// say) keeps whatever is already published for it. Returns what was done and anything worth a look.
export async function sizePhotos(from: string, to: string) {
  const notes: string[] = [];
  let sized = 0;
  for (const piece of list(from, true)) {
    const files = list(join(from, piece), false).filter(
      (f) => !IGNORED.test(f),
    );
    const copies = new Map<string, string>(); // the copy's file name -> its original
    for (const f of files) {
      const name = slugify(parse(f).name);
      if (!READABLE.test(f) || !name)
        notes.push(
          `${piece}/${f} was left out: save it as a JPEG or PNG with a name made of letters or numbers.`,
        );
      else if (copies.has(`${name}.jpg`))
        notes.push(
          `${piece}/${f} was left out: ${copies.get(`${name}.jpg`)} has the same name.`,
        );
      else copies.set(`${name}.jpg`, f);
    }
    if (!copies.size) continue;

    const out = join(to, piece);
    mkdirSync(join(out, "thumb"), { recursive: true });
    for (const [name, f] of copies) {
      const original = join(from, piece, f);
      try {
        const full = await size(original, join(out, name), FULL_PX);
        const thumb = await size(original, join(out, "thumb", name), THUMB_PX);
        if (full || thumb) sized++;
      } catch (e) {
        copies.delete(name);
        notes.push(
          `${piece}/${f} couldn't be read (${e instanceof Error ? e.message : e}).`,
        );
      }
    }
    // A photo taken out of the originals comes off the site too.
    for (const [dir, px] of [
      [out, FULL_PX],
      [join(out, "thumb"), THUMB_PX],
    ] as const)
      for (const name of list(dir, false)) {
        if (copies.has(name)) continue;
        if (await madeHere(join(dir, name), px)) rmSync(join(dir, name));
        else notes.push(misplaced(piece, join(dir, name)));
      }
  }
  // Originals put where the site's copies go, for a piece with nothing in `from` yet.
  for (const piece of list(to, true))
    for (const dir of [join(to, piece), join(to, piece, "thumb")])
      for (const name of list(dir, false))
        if (!(await madeHere(join(dir, name), FULL_PX)))
          notes.push(misplaced(piece, join(dir, name)));
  return { sized, notes: unique(notes) };
}

// Whether a published file could be one of this tool's copies: a JPEG no bigger than they're made.
// Anything else was put there by hand, most likely an original, and is never deleted.
async function madeHere(file: string, px: number) {
  try {
    const { format, width = 0, height = 0 } = await sharp(file).metadata();
    return format === "jpeg" && Math.max(width, height) <= px;
  } catch {
    return false;
  }
}

const misplaced = (piece: string, file: string) =>
  `${file} looks like an original, and the site would show it as it is. Move it to commission-photos/${piece}/ and build again.`;

// What's published: each piece's photos, in the order they're shown.
export const publishedPhotos = (to: string): Record<string, string[]> =>
  Object.fromEntries(
    list(to, true)
      .map((piece) => [piece, list(join(to, piece), false)] as const)
      .filter(([, photos]) => photos.length),
  );
