#!/usr/bin/env node
// Part of `npm run build`: sizes the photos in commission-photos/<piece>/ for the site and writes the
// list of them the Worker reads (worker/src/commission-photos.json). Only new or replaced photos are
// worked on, so it's quick when nothing has changed.
//
// Usage:
//   node tools/build-commission-photos.ts            # warns about a piece with no photos
//   node tools/build-commission-photos.ts --strict   # stops with an error instead (`npm run deploy`)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { publishedPhotos, sizePhotos } from "./commission-photos.ts";
import { PIECES } from "../worker/src/past-commissions.ts";

const at = (path: string) =>
  fileURLToPath(new URL(`../${path}`, import.meta.url));
const ORIGINALS = at("commission-photos");
const PUBLISHED = at("site/assets/commissions");
const LIST = at("worker/src/commission-photos.json");

const { sized, notes } = await sizePhotos(ORIGINALS, PUBLISHED);
const photos = publishedPhotos(PUBLISHED);

// Written only when it changes: `npm run dev` reloads the Worker whenever this file is touched.
const json = JSON.stringify(photos, null, 2) + "\n";
let before = "";
try {
  before = readFileSync(LIST, "utf8");
} catch {
  /* first run */
}
if (json !== before) writeFileSync(LIST, json);

const slugs = PIECES.map((p) => p.slug);
const bare = slugs.filter((slug) => !photos[slug]);
for (const slug of bare)
  notes.push(
    `"${slug}" has no photos yet: put some in commission-photos/${slug}/.`,
  );
for (const piece of Object.keys(photos))
  if (!slugs.includes(piece))
    notes.push(
      `site/assets/commissions/${piece}/ has photos, but no piece in worker/src/past-commissions.ts has the slug "${piece}".`,
    );

if (sized) console.log(`Commission photos: sized ${sized}.`);
for (const note of notes) console.warn(`Commission photos: ${note}`);

// The photos aren't in git, so a fresh copy of the repo has none until the originals are put back.
// `npm run deploy` stops here rather than publish the pieces without their photos.
if (process.argv.includes("--strict") && bare.length) {
  console.error(
    `Commission photos: not deploying, because ${bare.length === 1 ? "a piece has" : `${bare.length} pieces have`} no photos. Put the originals back in commission-photos/ (see "Past commissions" in the README).`,
  );
  process.exit(1);
}
