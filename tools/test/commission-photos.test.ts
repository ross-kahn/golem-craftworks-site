// Run with: npm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { publishedPhotos, sizePhotos } from "../commission-photos.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A folder of originals and an empty one to publish into.
function folders() {
  const root = mkdtempSync(join(tmpdir(), "gc-photos-"));
  dirs.push(root);
  return { from: join(root, "originals"), to: join(root, "published") };
}

async function photo(path: string, width: number, height: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  await sharp({
    create: { width, height, channels: 3, background: "#864" },
  })
    .png()
    .toFile(path);
}

const made = async (...path: string[]) => {
  mkdirSync(join(...path), { recursive: true });
  return join(...path);
};

const sizeOf = async (path: string) => {
  const { width, height } = await sharp(path).metadata();
  return [width, height];
};

test("photos: each original becomes a full-size JPEG and a thumbnail, in file-name order", async () => {
  const { from, to } = folders();
  await photo(join(from, "walnut-vault", "10 Lid.png"), 3000, 2000);
  await photo(join(from, "walnut-vault", "2 Front.png"), 1000, 2500);
  await photo(join(from, "walnut-vault", "IMG_0001.png"), 400, 300);
  writeFileSync(join(from, "walnut-vault", "notes.txt"), "not a photo");
  writeFileSync(join(from, "walnut-vault", "Thumbs.db"), "");
  mkdirSync(join(from, "empty-piece"));

  const { sized, notes } = await sizePhotos(from, to);
  assert.equal(sized, 3);
  assert.deepEqual(publishedPhotos(to), {
    "walnut-vault": ["2-front.jpg", "10-lid.jpg", "img-0001.jpg"],
  });
  const at = (...path: string[]) => join(to, "walnut-vault", ...path);
  assert.deepEqual(await sizeOf(at("10-lid.jpg")), [1600, 1067]);
  assert.deepEqual(await sizeOf(at("thumb", "10-lid.jpg")), [640, 427]);
  assert.deepEqual(await sizeOf(at("2-front.jpg")), [640, 1600]);
  assert.deepEqual(
    await sizeOf(at("img-0001.jpg")),
    [400, 300],
    "a small photo isn't blown up",
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^walnut-vault\/notes\.txt was left out/);
});

test("photos: only new or replaced ones are sized again, and removed ones come off the site", async () => {
  const { from, to } = folders();
  const original = (name: string) => join(from, "vault", name);
  await photo(original("a.png"), 800, 600);
  await photo(original("b.png"), 800, 600);
  await sizePhotos(from, to);
  assert.equal((await sizePhotos(from, to)).sized, 0);

  // Replaced with a different photo, which has its own date.
  await photo(original("a.png"), 600, 800);
  const earlier = new Date(statSync(original("a.png")).mtimeMs - 60_000);
  utimesSync(original("a.png"), earlier, earlier);
  rmSync(original("b.png"));
  assert.equal((await sizePhotos(from, to)).sized, 1);
  assert.deepEqual(await sizeOf(join(to, "vault", "a.jpg")), [600, 800]);
  assert.deepEqual(publishedPhotos(to), { vault: ["a.jpg"] });
  assert.ok(!existsSync(join(to, "vault", "thumb", "b.jpg")));
});

test("photos: a piece with no originals on this computer keeps what's published", async () => {
  const { from, to } = folders();
  await photo(join(from, "vault", "a.png"), 800, 600);
  await sizePhotos(from, to);
  rmSync(from, { recursive: true });
  assert.deepEqual(await sizePhotos(from, to), { sized: 0, notes: [] });
  assert.deepEqual(publishedPhotos(to), { vault: ["a.jpg"] });
});

test("photos: an original put where the site's copies go is pointed out, never deleted", async () => {
  const { from, to } = folders();
  await photo(join(from, "vault", "a.png"), 800, 600);
  await sharp({
    create: { width: 4000, height: 3000, channels: 3, background: "#864" },
  })
    .jpeg()
    .toFile(join(await made(to, "vault"), "PXL_1.jpg"));
  await photo(join(await made(to, "ring", "thumb"), "PXL_2.png"), 300, 200);

  const { notes } = await sizePhotos(from, to);
  assert.ok(existsSync(join(to, "vault", "PXL_1.jpg")));
  assert.ok(existsSync(join(to, "ring", "thumb", "PXL_2.png")));
  assert.equal(notes.length, 2);
  assert.match(notes[0], /PXL_1\.jpg looks like an original.*vault\/ and/);
  assert.match(notes[1], /PXL_2\.png looks like an original.*ring\/ and/);
});

test("photos: two originals that would get the same name", async () => {
  const { from, to } = folders();
  await photo(join(from, "vault", "Front.png"), 800, 600);
  await sharp(join(from, "vault", "Front.png"))
    .jpeg()
    .toFile(join(from, "vault", "front.jpg"));
  const { notes } = await sizePhotos(from, to);
  assert.deepEqual(publishedPhotos(to), { vault: ["front.jpg"] });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /has the same name/);
});
