// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCSV } from "../shared.ts";
import { planListings, attributeFor, setName, diceSetTitle } from "../etsy-listings.ts";

const CSV = [
  "﻿TITLE,DESCRIPTION,PRICE,CURRENCY_CODE,QUANTITY,TAGS,MATERIALS,IMAGE1,VARIATION 1 TYPE,VARIATION 1 NAME,VARIATION 1 VALUES,VARIATION 2 TYPE,VARIATION 2 NAME,VARIATION 2 VALUES,SKU",
  '"WILD MAGIC Handmade Dice, 8 Piece","Line one.\n\nSays ""hi"".",55.00,USD,7,"dice,dnd",resin,https://i.etsystatic.com/1.jpg,,,,,,,RPG-WILD-MAGIC',
  'Heirloom Yahtzee Set,A box.,45,USD,6,,,,,Wood,"Walnut,Maple",,,,"YZ-WAL,YZ-MAP"',
  "HUNTER Handmade Dice,New words.,99,USD,3,hunter,,,,,,,,,rpg-hunter",
  "Seasnail dice!,,55,USD,1,,,,,,,,,,",
  "No Sku Dice,,30.5,USD,2,,,,,,,,,,",
  "Free Thing,,0,USD,1,,,,,,,,,,FREE-1",
  "Second Copy,,55,USD,1,,,,,,,,,,RPG-WILD-MAGIC"
].join("\r\n");

test("Etsy export: new SKUs become items, known SKUs get their details updated", () => {
  const rows = parseCSV(CSV);
  assert.equal(rows.length, 7);
  const plan = planListings(rows, { skus: new Set(["RPG-HUNTER"]), titles: new Set(["seasnail dice"]) });

  // Etsy's quantity column is ignored: the import gives every new piece the same starting stock.
  assert.deepEqual(plan.create.map((i) => [i.title, i.priceCents, i.variations, i.metadata]), [
    ['"WILD MAGIC" TTRPG Dice Set', 5500, [{ name: "Regular", sku: "RPG-WILD-MAGIC" }], { TITLE: "WILD MAGIC Handmade Dice, 8 Piece", TAGS: "dice,dnd", MATERIALS: "resin" }],
    ["Heirloom Yahtzee Set", 4500, [{ name: "Walnut", sku: "YZ-WAL" }, { name: "Maple", sku: "YZ-MAP" }], { TITLE: "Heirloom Yahtzee Set" }],
    ["No Sku Dice", 3050, [{ name: "Regular", sku: "" }], { TITLE: "No Sku Dice" }]
  ]);
  assert.equal(plan.create[0].description, 'Line one.\n\nSays "hi".');
  assert.ok(plan.create[2].notes[0].startsWith("no SKU"));

  // Already in Square by SKU (whatever its capitals): title, description and metadata only. No price in the plan at all.
  assert.deepEqual(plan.update, [{ sku: "RPG-HUNTER", title: '"HUNTER" TTRPG Dice Set', keepTitle: false, description: "New words.", metadata: { TITLE: "HUNTER Handmade Dice", TAGS: "hunter" } }]);

  assert.deepEqual(plan.skipped, [
    { title: "Seasnail dice!", reason: "an item with this title is already in Square under a different SKU" },
    { title: "Free Thing", reason: 'no usable price ("0")' },
    { title: "Second Copy", reason: "SKU RPG-WILD-MAGIC is on an earlier listing in this export" }
  ]);
});

test("Etsy export: two options are combined into one Square variation each", () => {
  const rows = [{ TITLE: "Vault", PRICE: "40", "VARIATION 1 VALUES": "Walnut, Cherry", "VARIATION 2 VALUES": "Small, Large", SKU: "A,B,C" }];
  const [item] = planListings(rows, { skus: new Set(), titles: new Set() }).create;
  assert.deepEqual(item.variations, [
    { name: "Walnut, Small", sku: "" }, { name: "Walnut, Large", sku: "" },
    { name: "Cherry, Small", sku: "" }, { name: "Cherry, Large", sku: "" }
  ]);
  assert.ok(item.notes.some((n) => n.startsWith("3 SKUs (A, B, C) for 4 options")), "SKUs aren't guessed onto options");
  const [lined] = planListings([{ ...rows[0], SKU: "A,B,C,D" }], { skus: new Set(), titles: new Set() }).create;
  assert.deepEqual(lined.variations.map((v) => v.sku), ["A", "B", "C", "D"]);
});

test("dice sets get the short standard name; everything else keeps its own", () => {
  assert.equal(diceSetTitle("WILD MAGIC Handmade Dice – 8 Piece Sharp Edge Set for Dungeons and Dragons (D&D)"), '"WILD MAGIC" TTRPG Dice Set');
  assert.equal(diceSetTitle("FOOL'S GOLD Handmade Dice – 8 Piece"), `"FOOL'S GOLD" TTRPG Dice Set`);
  assert.equal(diceSetTitle("VAMPYR Handmade Resin TTRPG Dice Set – D&D, Pathfinder"), '"VAMPYR" TTRPG Dice Set');
  assert.equal(diceSetTitle("SEASNAIL Handmade Sharp Edge Dice Set for TTRPGs e.g. Dungeons & Dragons, and More Copy Copy"), '"SEASNAIL" TTRPG Dice Set');
  // Already renamed, not dice, or no set name up front: left alone.
  for (const t of ['"JAVA" TTRPG Dice Set', "Art Deco Hardwood Yahtzee Box - Handmade Dice Set", "FROST GIANT", "Premium RPG Set", "Dice Jail", "A dice set"]) {
    assert.equal(diceSetTitle(t), null, t);
  }
  assert.equal(setName("BUBBLEGUM SODA Handmade Dice"), "BUBBLEGUM SODA");

  // An existing item that isn't a dice set keeps its Square name; only the description comes across.
  const rows = [{ TITLE: "Art Deco Hardwood Yahtzee Box - Handmade Dice Set", DESCRIPTION: "A box.", PRICE: "45", SKU: "yahtzee-walnut" }];
  const [u] = planListings(rows, { skus: new Set(["YAHTZEE-WALNUT"]), titles: new Set() }).update;
  assert.deepEqual([u.sku, u.keepTitle], ["YAHTZEE-WALNUT", true]);
});

test("Etsy export: extra columns map to Square custom attribute names", () => {
  assert.deepEqual(attributeFor("TAGS"), { key: "etsy_tags", name: "Etsy tags" });
  assert.deepEqual(attributeFor("ITEM WEIGHT (OZ)"), { key: "etsy_item_weight_oz", name: "Etsy item weight (oz)" });
});
