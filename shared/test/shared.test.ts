// Run with: npm test
// The helpers the Worker, the site and the tools share.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvList,
  decodeEntities,
  esc,
  htmlToText,
  slugify,
  withoutSlash,
  words,
} from "../text.ts";
import { byCategory, tilePhotos } from "../catalog.ts";
import { paged } from "../paged.ts";
import { check, isEmail, line, paragraph } from "../validate.ts";
import { Commission, Review } from "../forms.ts";
import * as v from "valibot";

test("slugify: the addresses products and categories are served at", () => {
  // These are live addresses. If one of these changes, links to the shop break.
  assert.equal(slugify('"JAVA" TTRPG Dice Set'), "java-ttrpg-dice-set");
  assert.equal(slugify("8-piece RPG Dice"), "8-piece-rpg-dice");
  assert.equal(slugify("Fool’s Gold & Café Crème"), "fools-gold-cafe-creme");
  assert.equal(slugify("  --Hex dice vault!  "), "hex-dice-vault");
  assert.equal(slugify("★"), "");
});

test("csvList: a comma-separated setting as a list", () => {
  assert.deepEqual(csvList(" Dice, Wood ,,In-Person "), [
    "Dice",
    "Wood",
    "In-Person",
  ]);
  assert.deepEqual(csvList(""), []);
  assert.deepEqual(csvList(undefined), []);
});

test("esc, words, withoutSlash", () => {
  assert.equal(
    esc(`<a href="x">Tom & Jerry's</a>`),
    "&#60;a href=&#34;x&#34;&#62;Tom &#38; Jerry&#39;s&#60;/a&#62;",
  );
  assert.equal(esc(null), "");
  assert.equal(words("  WILD-MAGIC: 8 Piece!"), "wild magic 8 piece");
  assert.equal(withoutSlash("https://a.test/"), "https://a.test");
  assert.equal(withoutSlash("https://a.test"), "https://a.test");
});

test("decodeEntities and htmlToText: what Etsy and Square send, as plain text", () => {
  assert.equal(
    decodeEntities("can&#39;t &amp; won&#x27;t &quot;ever&quot; &nbsp;&bogus;"),
    `can't & won't "ever"  &bogus;`,
  );
  assert.equal(
    htmlToText(
      "<p>One<br>two</p><ul><li>a</li><li>b &amp; c</li></ul><p>Three</p>",
    ),
    "One\ntwo\n\n- a\n- b & c\n\nThree",
  );
  assert.equal(htmlToText(undefined), "");
});

test("categories run A to Z with Other last", () => {
  assert.deepEqual(
    ["Other", "Woodworks", "8-piece RPG Dice", "Game sets"].sort(byCategory),
    ["8-piece RPG Dice", "Game sets", "Woodworks", "Other"],
  );
});

test("a category tile takes one photo from each piece before any second photos", () => {
  assert.deepEqual(tilePhotos([["a1", "a2", "a3"], ["b1"], [], ["c1", "c2"]]), [
    "a1",
    "b1",
    "c1",
    "a2",
  ]);
  assert.deepEqual(tilePhotos([["a1", "a2"]]), ["a1", "a2"]);
  assert.deepEqual(tilePhotos([]), []);
});

test("paged: follows the cursor until there isn't one", async () => {
  const asked: (string | undefined)[] = [];
  const pages: Record<string, { items: number[]; cursor?: string }> = {
    start: { items: [1, 2], cursor: "b" },
    b: { items: [3], cursor: "c" },
    c: { items: [] },
  };
  const got: number[] = [];
  for await (const page of paged(async (cursor?: string) => {
    asked.push(cursor);
    return pages[cursor || "start"];
  }))
    got.push(...page.items);
  assert.deepEqual(got, [1, 2, 3]);
  assert.deepEqual(asked, [undefined, "b", "c"]);
});

test("email addresses: one @, no spaces, a dotted domain with a 2+ letter ending", () => {
  for (const ok of [
    "jane@example.com",
    "a.b+tag@sub.example.co.uk",
    "x_y@ex-ample.io",
    "  jane@example.com  ",
  ])
    assert.ok(isEmail(ok), ok);
  for (const bad of [
    "",
    "jane",
    "jane@",
    "@example.com",
    "jane@example",
    "jane@example.c",
    "ja ne@example.com",
    "jane@@example.com",
    "jane@example..com",
    "jane@-example.com",
    "jane@example.com, other@example.com",
    "<jane@example.com>",
    "jane@example.com\nBcc: x@y.com",
    "a".repeat(250) + "@example.com",
    42,
    null,
  ])
    assert.ok(!isEmail(bad), String(bad));
});

test("form fields: tidied, cut to length, and never anything but text", () => {
  const parse = (schema: v.GenericSchema, x: unknown) =>
    v.parse(v.object({ f: schema }), { f: x }).f;
  assert.equal(parse(line(10), "  Jane\r\nBcc:\tx  "), "Jane Bcc: ");
  assert.equal(parse(paragraph(20), "  one\n\ntwo  "), "one\n\ntwo");
  assert.equal(parse(paragraph(3), "abcdef"), "abc");
  for (const notText of [undefined, null, 7, ["a"], { a: 1 }])
    assert.equal(parse(line(10), notText), "");
  assert.equal(v.parse(v.object({ f: line(10) }), {}).f, "");
});

test("commission form: what's missing, in the order the form asks for it", () => {
  const all = check(Commission, {});
  assert.deepEqual(all.missing, [
    "your name",
    "a valid email",
    "a description of your idea",
  ]);
  assert.deepEqual(all.fields, ["name", "email", "idea"]);
  assert.equal(all.data.type, "Something else");

  const some = check(Commission, {
    name: "Jane",
    email: "jane@example",
    idea: "  A vault.  ",
    type: "Dice",
  });
  assert.deepEqual(some.missing, ["a valid email"]);
  assert.deepEqual(some.fields, ["email"]);

  const good = check(Commission, {
    name: " Jane Doe ",
    email: "jane@example.com",
    type: "Not a type",
    idea: "A vault.\nWith initials.",
    when: "soon",
    extra: "ignored",
  });
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.data, {
    name: "Jane Doe",
    email: "jane@example.com",
    type: "Something else",
    idea: "A vault.\nWith initials.",
    when: "soon",
    budget: "",
  });
  for (const junk of [null, "text", 5, []])
    assert.equal(check(Commission, junk).missing.length, 3);
});

test("review form: the rating is a whole number from 1 to 5", () => {
  const base = {
    name: "  Jane   Doe ",
    email: "jane@example.com",
    text: "Lovely.",
  };
  for (const rating of ["1", "5"]) {
    const r = check(Review, { ...base, rating });
    assert.deepEqual(r.missing, []);
    assert.equal(r.data.rating, Number(rating));
    assert.equal(r.data.name, "Jane Doe");
  }
  for (const rating of ["", "0", "6", "4.5", "five", undefined])
    assert.deepEqual(
      check(Review, { ...base, rating }).missing,
      ["a star rating"],
      String(rating),
    );
  assert.deepEqual(check(Review, {}).missing, [
    "your name",
    "a valid email",
    "a star rating",
    "a few words about it",
  ]);
  // The spam-check fields come through whatever else is wrong.
  const spam = check(Review, { website: "http://x", elapsed: "1200" });
  assert.equal(spam.data.website, "http://x");
  assert.equal(spam.data.elapsed, 1200);
});
