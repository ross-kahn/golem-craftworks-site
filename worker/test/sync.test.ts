// Run with: npm test
// Exercises the Worker against fake Square and Etsy APIs (no network, no real accounts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import worker from "../src/index.ts";
import * as square from "../src/square.ts";
import { pushToEtsy, recordEtsyReceipt, reconcile } from "../src/sync.ts";
import type { Env, LogLine } from "../src/types.ts";

// ---------- fakes ----------
class KV {
  m = new Map<string, string>();
  async get(k: string, type?: string) { const v = this.m.get(k); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; }
  async put(k: string, v: string) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
}
(globalThis as any).caches = { default: { match: async () => null, put: async () => {}, delete: async () => true } };

// The fakes mirror raw API payloads, so they're left loosely typed.
let state: any, calls: { method: string; url: string; body: any }[];
const LOC = "LOC1";

function freshState() {
  return {
    catalog: [
      item("I_DICE", "Ember dice set", [variation("V_DICE", "Default", 4500, "DICE-1", true)], { cat: "C_DICE" }),
      item("I_YZ", "Yahtzee set", [
        variation("V_WAL", "Walnut", 6500, "YZ-WAL", true),
        variation("V_CHE", "Cherry", 6000, "YZ-CHE", true)
      ], { cat: "C_GAME", image: "IMG1", lists: [
        { modifier_list_id: "ML_DICE", min_selected_modifiers: -1, max_selected_modifiers: -1 },
        { modifier_list_id: "ML_FINISH", ordinal: 2, modifier_overrides: [{ modifier_id: "M_GLOSS", on_by_default_override: "YES" }] },
        { modifier_list_id: "ML_OFF", enabled: false },
        { modifier_list_id: "ML_TEXT" }
      ] }),
      item("I_STICKER", "Sticker", [variation("V_STK", "Default", 300, "STK", false)], { cat: "C_MISC" }),
      item("I_OLD", "Archived thing", [variation("V_OLD", "Default", 100, "OLD", true)], { archived: true })
    ],
    related: [
      { id: "C_DICE", type: "CATEGORY", category_data: { name: "Dice" } },
      { id: "C_GAME", type: "CATEGORY", category_data: { name: "Game sets" } },
      { id: "C_MISC", type: "CATEGORY", category_data: { name: "Market only" } },
      { id: "IMG1", type: "IMAGE", image_data: { url: "https://img/yz.jpg" } },
      modifierList("ML_DICE", "Dice", { selection_type: "MULTIPLE" }, [
        modifier("M_HAND", "Handmade dice", 1500, { on_by_default: true }),
        modifier("M_SECRET", "Staff only", 0, { hidden_online: true })
      ]),
      modifierList("ML_FINISH", "Finish", { selection_type: "SINGLE" }, [
        modifier("M_SATIN", "Satin", 0, { on_by_default: true }),
        modifier("M_GLOSS", "Gloss", 500)
      ]),
      modifierList("ML_OFF", "Turned off", {}, [modifier("M_OFF", "Off", 100)]),
      modifierList("ML_TEXT", "Engraving text", { modifier_type: "TEXT" }, [])
    ],
    counts: { V_DICE: 1, V_WAL: 3, V_CHE: 0, V_OLD: 5 },
    listings: {
      101: { listing_id: 101, state: "active", quantity: 1, skus: ["DICE-1"], title: "Ember" },
      202: { listing_id: 202, state: "active", quantity: 5, skus: ["YZ-WAL", "YZ-CHE"], title: "Yahtzee" },
      303: { listing_id: 303, state: "active", quantity: 9, skus: ["STK"], title: "Sticker" }
    },
    inventories: {
      101: inv([["DICE-1", 1, true]]),
      202: inv([["YZ-WAL", 3, true, 513], ["YZ-CHE", 2, true, 514]]),
      303: inv([["STK", 9, true]])
    },
    receipts: [],
    squareAdjustments: [],
    paymentLinks: []
  };
}

function item(id: string, name: string, variations: object[],
  { cat, image, archived, lists }: { cat?: string; image?: string; archived?: boolean; lists?: object[] } = {}) {
  return { id, type: "ITEM", updated_at: "2026-09-01T00:00:00Z", present_at_all_locations: true,
    item_data: { name, description_plaintext: `${name} description`, is_archived: !!archived,
      categories: cat ? [{ id: cat }] : [], image_ids: image ? [image] : [], variations, modifier_list_info: lists || [] } };
}
function modifierList(id: string, name: string, data: object, modifiers: object[]) {
  return { id, type: "MODIFIER_LIST", present_at_all_locations: true, modifier_list_data: { name, ...data, modifiers } };
}
function modifier(id: string, name: string, price: number, data: object = {}) {
  return { id, type: "MODIFIER", present_at_all_locations: true,
    modifier_data: { name, price_money: { amount: price, currency: "USD" }, ...data } };
}
function variation(id: string, name: string, price: number, sku: string, track: boolean) {
  return { id, type: "ITEM_VARIATION", present_at_all_locations: true,
    item_variation_data: { name, sku, price_money: { amount: price, currency: "USD" }, pricing_type: "FIXED_PRICING", track_inventory: track } };
}
function inv(rows: [sku: string, qty: number, enabled: boolean, valueId?: number][]) {
  return {
    products: rows.map(([sku, qty, enabled, valueId], i) => ({
      product_id: 9000 + i, sku, is_deleted: false,
      property_values: valueId ? [{ property_id: 200, property_name: "Wood", scale_id: null, scale_name: null, value_ids: [valueId], values: [sku] }] : [],
      offerings: [{ offering_id: 7000 + i, quantity: qty, is_enabled: enabled, is_deleted: false, price: { amount: 6500, divisor: 100, currency_code: "USD" } }]
    })),
    price_on_property: [], quantity_on_property: rows.length > 1 ? [200] : [], sku_on_property: rows.length > 1 ? [200] : []
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: unknown, init: any = {}) => {
  const url = String(input);
  const method = init.method || "GET";
  const body = init.body && init.headers && String(init.headers["content-type"]).includes("json") ? JSON.parse(init.body) : init.body;
  calls.push({ method, url, body });

  // ---- Square ----
  if (url.endsWith("/v2/catalog/search")) {
    if (body.object_types[0] === "ITEM_VARIATION") {
      const sku = body.query.exact_query.attribute_value;
      const v = state.catalog.flatMap((i: any) => i.item_data.variations).find((x: any) => x.item_variation_data.sku === sku);
      return ok({ objects: v ? [v] : [] });
    }
    return ok({ objects: state.catalog, related_objects: state.related });
  }
  if (url.endsWith("/v2/catalog/batch-retrieve")) {
    const all = state.catalog.flatMap((i: any) => i.item_data.variations);
    return ok({ objects: all.filter((v: any) => body.object_ids.includes(v.id)) });
  }
  if (url.endsWith("/v2/inventory/counts/batch-retrieve")) {
    return ok({ counts: body.catalog_object_ids.filter((id: string) => id in state.counts)
      .map((id: string) => ({ catalog_object_id: id, location_id: LOC, state: "IN_STOCK", quantity: String(state.counts[id]) })) });
  }
  if (url.endsWith("/v2/inventory/changes/batch-create")) {
    state.squareAdjustments.push(body);
    const a = body.changes[0].adjustment;
    state.counts[a.catalog_object_id] -= Number(a.quantity);
    return ok({ counts: [] });
  }
  if (url.endsWith("/v2/online-checkout/payment-links")) {
    state.paymentLinks.push(body);
    return ok({ payment_link: { id: "PL1", url: "https://square.link/u/abc" } });
  }

  // ---- Etsy ----
  if (url.includes("openapi.etsy.com")) {
    assert.equal(init.headers["x-api-key"], "KEY:SECRET");
    let m: RegExpMatchArray | null;
    if ((m = url.match(/\/shops\/\d+\/listings\?state=(\w+)/))) {
      return ok({ count: 0, results: Object.values(state.listings).filter((l: any) => l.state === m![1]) });
    }
    if ((m = url.match(/\/listings\/(\d+)\/inventory$/))) {
      if (method === "PUT") { state.inventories[m[1]] = { ...state.inventories[m[1]], put: body }; return ok({}); }
      return ok(structuredClone(state.inventories[m[1]]));
    }
    if ((m = url.match(/\/shops\/\d+\/listings\/(\d+)$/)) && method === "PATCH") {
      const st = new URLSearchParams(init.body).get("state");
      state.listings[m[1]].state = st;
      return ok(state.listings[m[1]]);
    }
    if ((m = url.match(/\/listings\/(\d+)$/))) return ok(state.listings[m[1]]);
    if (url.includes("/receipts/")) return ok(state.receipts[0]);
    if (url.includes("/receipts?")) return ok({ results: state.receipts });
  }
  throw new Error("Unexpected fetch " + method + " " + url);
}) as typeof fetch;

function makeEnv(extra: Partial<Env> = {}): Env {
  const kv = new KV();
  kv.m.set("etsy:tokens", JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3600e3 }));
  return {
    GC_KV: kv as unknown as KVNamespace, SQUARE_ACCESS_TOKEN: "sq", SQUARE_LOCATION_ID: LOC, SQUARE_ENV: "sandbox",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "sigkey", SQUARE_WEBHOOK_URL: "https://w.example/webhooks/square",
    ETSY_KEYSTRING: "KEY", ETSY_SHARED_SECRET: "SECRET", ETSY_SHOP_ID: "55",
    ETSY_WEBHOOK_SECRET: "whsec_" + Buffer.from("etsy-secret-bytes").toString("base64"),
    SITE_URL: "https://golemcraftworks.com", ALLOWED_ORIGINS: "https://golemcraftworks.com",
    SHIPPING_FLAT_CENTS: "800", HIDDEN_CATEGORIES: "Market only", ADMIN_TOKEN: "admintoken",
    SYNC_DRY_RUN: "false", ...extra
  };
}
const ctx = () => { const p: Promise<unknown>[] = []; return { waitUntil: (x: Promise<unknown>) => { p.push(x); }, done: () => Promise.all(p) }; };

beforeEach(() => { state = freshState(); calls = []; });

// ---------- tests ----------

test("storefront: hides archived and hidden-category items, keeps stock and untracked items", async () => {
  const { products, skuMap, tracked } = await square.buildStorefront(makeEnv());
  assert.deepEqual(products.map((p) => p.name).sort(), ["Ember dice set", "Yahtzee set"]);
  const yz = products.find((p) => p.id === "I_YZ")!;
  assert.equal(yz.category, "Game sets");
  assert.deepEqual(yz.images, ["https://img/yz.jpg"]);
  assert.deepEqual(yz.variations.map((v) => [v.name, v.qty, v.priceCents]), [["Walnut", 3, 6500], ["Cherry", 0, 6000]]);
  assert.equal(skuMap["STK"], "V_STK", "hidden items still map for Etsy sales");
  assert.equal(tracked.has("V_STK"), false);
});

test("storefront: an item marked sold out in Square shows as sold, even when stock isn't counted", async () => {
  const sticker = state.catalog[2];
  sticker.item_data.categories = [{ id: "C_DICE" }]; // otherwise hidden; its stock isn't tracked
  const qty = async () => (await square.buildStorefront(makeEnv())).products.find((p) => p.id === "I_STICKER")!.variations[0].qty;
  assert.equal(await qty(), null);
  sticker.item_data.variations[0].item_variation_data.location_overrides = [{ location_id: LOC, sold_out: true }];
  assert.equal(await qty(), 0);
});

test("storefront: newest pieces come first, and editing one doesn't move it", async () => {
  const [dice, yahtzee] = state.catalog;
  dice.created_at = "2026-03-01T00:00:00Z"; dice.updated_at = "2026-10-06T00:00:00Z"; // old, just edited
  yahtzee.created_at = "2026-09-15T00:00:00Z"; yahtzee.updated_at = "2026-09-15T00:00:00Z";
  const order = async () => (await square.buildStorefront(makeEnv())).products.map((p) => p.id);
  assert.deepEqual(await order(), ["I_YZ", "I_DICE"]);
  // Added in the same batch: alphabetical, so the order is steady.
  dice.created_at = yahtzee.created_at;
  assert.deepEqual(await order(), ["I_DICE", "I_YZ"]);
});

test("storefront: descriptions keep their paragraphs", async () => {
  const d = state.catalog[1].item_data;
  d.description_plaintext = "One.\nTwo:\nA, B\nThree & <four>";
  d.description_html = "<p>One.</p><p>Two:<br>A, B</p>\n<ul><li>Walnut</li><li>Maple</li></ul><p>Three &amp; &lt;four&gt; &#39;five&#39;&nbsp;six</p>";
  const text = async () => (await square.buildStorefront(makeEnv())).products.find((p) => p.id === "I_YZ")!.description;
  assert.equal(await text(), "One.\n\nTwo:\nA, B\n\n- Walnut\n- Maple\n\nThree & <four> 'five' six");
  delete d.description_html;
  assert.equal(await text(), "One.\nTwo:\nA, B\nThree & <four>", "plain text is the fallback");
});

test("storefront: dice sets share one description, with Square's text as the set-specific part", async () => {
  const d = state.catalog[0].item_data;
  d.name = '"EMBER" TTRPG Dice Set';
  d.description_html = "<p>Glows like a $5 campfire.</p>";
  const text = async () => (await square.buildStorefront(makeEnv())).products.find((p) => p.id === "I_DICE")!.description;
  const paragraphs = (await text()).split("\n\n");
  assert.deepEqual(paragraphs.slice(0, 3), ["EMBER 8-Piece Dice Set", "Tabletop Gaming Dice for Dungeons & Dragons (D&D), Pathfinder, Call of Cthulhu, Shadowrun, and more", "Glows like a $5 campfire."]);
  assert.equal(paragraphs.at(-1), "Thanks for checking out my work!");

  // A description not yet trimmed in Square doesn't say everything twice.
  d.description_html = "<p>EMBER 8-Piece Dice Set</p><p>Glows like a $5 campfire.</p><p>Thanks for checking out my work, cheers!</p>";
  assert.deepEqual((await text()).split("\n\n"), paragraphs);

  delete d.description_html; d.description_plaintext = "";
  assert.deepEqual((await text()).split("\n\n"), paragraphs.filter((p) => !p.startsWith("Glows")), "nothing set-specific: the template alone");
});

test("storefront: modifier lists carry Square's defaults and limits", async () => {
  const { products } = await square.buildStorefront(makeEnv());
  assert.deepEqual(products.find((p) => p.id === "I_DICE")!.modifierLists, []);
  assert.deepEqual(products.find((p) => p.id === "I_YZ")!.modifierLists, [
    // Hidden-online modifiers are dropped; the list's own default applies.
    { id: "ML_DICE", name: "Dice", min: 0, max: 1, modifiers: [{ id: "M_HAND", name: "Handmade dice", priceCents: 1500, default: true }] },
    // Pick-one list: the item's override turns Gloss on, and only one default survives.
    { id: "ML_FINISH", name: "Finish", min: 0, max: 1, modifiers: [
      { id: "M_SATIN", name: "Satin", priceCents: 0, default: true },
      { id: "M_GLOSS", name: "Gloss", priceCents: 500, default: false }
    ] }
  ]);

  // The item's own min/max win over the list's.
  state.catalog[1].item_data.modifier_list_info[1].min_selected_modifiers = 1;
  state.related.find((r: any) => r.id === "ML_DICE").modifier_list_data.modifiers[0].modifier_data.on_by_default = false;
  const again = (await square.buildStorefront(makeEnv())).products.find((p) => p.id === "I_YZ")!.modifierLists;
  assert.deepEqual([again[1].min, again[1].max], [1, 1]);
  assert.equal(again[0].modifiers[0].default, false);
});

test("Square -> Etsy: one-of-a-kind sells in person, Etsy listing is deactivated", async () => {
  const env = makeEnv();
  const r = await pushToEtsy(env, "DICE-1", 0);
  assert.equal(r.updated, true);
  assert.deepEqual(r.plan, ["deactivate-listing"]);
  assert.equal(state.listings[101].state, "inactive");
});

test("Square -> Etsy: variation sells out, offering disabled and read-only fields stripped", async () => {
  const env = makeEnv();
  const r = await pushToEtsy(env, "YZ-CHE", 0);
  assert.deepEqual(r.plan, ["set-quantity"]);
  const put = state.inventories[202].put;
  const che = put.products.find((p: any) => p.sku === "YZ-CHE");
  assert.deepEqual(che.offerings, [{ price: 65, quantity: 0, is_enabled: false }]);
  assert.equal("product_id" in che, false);
  assert.equal("offering_id" in che.offerings[0], false);
  assert.deepEqual(che.property_values[0].value_ids, [514]);
  const wal = put.products.find((p: any) => p.sku === "YZ-WAL");
  assert.deepEqual(wal.offerings, [{ price: 65, quantity: 3, is_enabled: true }], "other variations untouched");
  assert.deepEqual(put.quantity_on_property, [200]);
});

test("Square -> Etsy: no change means no Etsy writes", async () => {
  const r = await pushToEtsy(makeEnv(), "YZ-WAL", 3);
  assert.equal(r.unchanged, true);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});

test("Square -> Etsy: restock reactivates a listing the sync turned off", async () => {
  const env = makeEnv();
  await pushToEtsy(env, "DICE-1", 0);
  const r = await pushToEtsy(env, "DICE-1", 1);
  assert.deepEqual(r.plan, ["set-quantity", "activate-listing"]);
  assert.equal(state.listings[101].state, "active");
});

test("dry run changes nothing", async () => {
  const env = makeEnv({ SYNC_DRY_RUN: "true" });
  const r = await pushToEtsy(env, "DICE-1", 0);
  assert.equal(r.dryRun, true);
  assert.equal(state.listings[101].state, "active");
  const log = await env.GC_KV.get<LogLine[]>("log", "json");
  assert.match(log![0].message, /DRY RUN/);
});

test("Etsy -> Square: sale recorded once even if delivered twice", async () => {
  const env = makeEnv();
  const receipt = { receipt_id: 777, is_paid: true, transactions: [{ transaction_id: 1, sku: "YZ-WAL", quantity: 1 }] };
  await recordEtsyReceipt(env, receipt);
  const again = await recordEtsyReceipt(env, receipt);
  assert.equal(again.skipped, "already-recorded");
  assert.equal(state.squareAdjustments.length, 1);
  const a = state.squareAdjustments[0];
  assert.equal(a.idempotency_key, "etsy-777-1");
  assert.equal(a.changes[0].adjustment.to_state, "SOLD");
  assert.equal(state.counts.V_WAL, 2);
});

test("Square webhook: valid signature accepted, Etsy updated from live count", async () => {
  const env = makeEnv();
  state.counts.V_DICE = 0; // sold at a market
  const event = { event_id: "e1", type: "inventory.count.updated", data: { object: { inventory_counts: [
    { catalog_object_id: "V_DICE", catalog_object_type: "ITEM_VARIATION", location_id: LOC, state: "IN_STOCK", quantity: "1" } // stale payload
  ] } } };
  const raw = JSON.stringify(event);
  const sig = createHmac("sha256", "sigkey").update(env.SQUARE_WEBHOOK_URL + raw).digest("base64");
  const c = ctx();
  const res = await worker.fetch(new Request("https://w.example/webhooks/square", {
    method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": sig } }), env, c);
  assert.equal(res.status, 200);
  await c.done();
  assert.equal(state.listings[101].state, "inactive", "used live count 0, not stale payload 1");

  const bad = await worker.fetch(new Request("https://w.example/webhooks/square", {
    method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": "nope" } }), env, ctx());
  assert.equal(bad.status, 401);
});

test("Etsy webhook: signature verified per Etsy's scheme and sale recorded", async () => {
  const env = makeEnv();
  state.receipts = [{ receipt_id: 888, is_paid: true, transactions: [{ transaction_id: 5, sku: "DICE-1", quantity: 1 }] }];
  const raw = JSON.stringify({ event_type: "order.paid", resource_url: "https://openapi.etsy.com/v3/application/shops/55/receipts/888", shop_id: 55 });
  const id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", Buffer.from("etsy-secret-bytes")).update(`${id}.${ts}.${raw}`).digest("base64");
  const c = ctx();
  const res = await worker.fetch(new Request("https://w.example/webhooks/etsy", {
    method: "POST", body: raw, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } }), env, c);
  assert.equal(res.status, 200);
  await c.done();
  assert.equal(state.counts.V_DICE, 0);

  const stale = await worker.fetch(new Request("https://w.example/webhooks/etsy", {
    method: "POST", body: raw, headers: { "webhook-id": id, "webhook-timestamp": "1000", "webhook-signature": `v1,${sig}` } }), env, ctx());
  assert.equal(stale.status, 401, "old timestamps rejected");
});

test("hourly check: catches a missed Etsy sale, lowers Etsy, never raises, ignores untracked", async () => {
  const env = makeEnv();
  // Etsy shows 5 Yahtzee sets but Square has 3 (+0 cherry): should lower cherry to 0 disabled.
  // Sticker is untracked in Square: must be left alone even though Square has no count.
  // A missed Etsy sale of the dice: should be recorded in Square first.
  state.receipts = [{ receipt_id: 999, is_paid: true, transactions: [{ transaction_id: 9, sku: "DICE-1", quantity: 1 }] }];
  state.listings[101].state = "sold_out"; // Etsy marked it sold
  const report = await reconcile(env);
  assert.equal(state.counts.V_DICE, 0, "missed Etsy sale recorded");
  assert.deepEqual(report.lowered.map((l) => l.sku), ["YZ-CHE"]);
  assert.equal(state.listings[303].state, "active", "untracked sticker untouched");
  assert.equal(state.listings[101].state, "sold_out", "sold piece not relisted");
  assert.deepEqual(report.etsyOnly, []);
});

test("checkout: blocks sold items and builds a Square link with shipping and taxes", async () => {
  const env = makeEnv();
  const post = (b: unknown) => worker.fetch(new Request("https://w.example/api/checkout", {
    method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", origin: "https://golemcraftworks.com" } }), env, ctx());

  const sold = await post({ lines: [{ variationId: "V_CHE", qty: 1 }], fulfillment: "ship" });
  assert.equal(sold.status, 409);
  assert.deepEqual(((await sold.json()) as any).soldOut, ["V_CHE"]);

  const okRes = await post({ lines: [{ variationId: "V_WAL", qty: 2 }, { variationId: "V_DICE", qty: 1 }], fulfillment: "ship" });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("access-control-allow-origin"), "https://golemcraftworks.com");
  assert.equal(((await okRes.json()) as any).url, "https://square.link/u/abc");
  const link = state.paymentLinks[0];
  assert.deepEqual(link.order.line_items, [{ catalog_object_id: "V_WAL", quantity: "2" }, { catalog_object_id: "V_DICE", quantity: "1" }]);
  assert.equal(link.order.pricing_options.auto_apply_taxes, true);
  assert.equal(link.checkout_options.shipping_fee.charge.amount, 800);
  assert.equal(link.checkout_options.redirect_url, "https://golemcraftworks.com/thanks/");

  await post({ lines: [{ variationId: "V_WAL", qty: 1 }], fulfillment: "pickup" });
  const pickup = state.paymentLinks[1];
  assert.equal(pickup.checkout_options.ask_for_shipping_address, false);
  assert.equal(pickup.checkout_options.shipping_fee, undefined);

  const tooMany = await post({ lines: [{ variationId: "V_DICE", qty: 2 }] });
  assert.equal(tooMany.status, 409, "can't buy two of a one-of-a-kind");

  const hidden = await post({ lines: [{ variationId: "V_STK", qty: 1 }] });
  assert.equal(hidden.status, 409, "can't buy something the site doesn't list");
});

test("checkout: add-ons are sent to Square, checked against the item's rules, and share stock", async () => {
  const env = makeEnv();
  const post = (b: unknown) => worker.fetch(new Request("https://w.example/api/checkout", {
    method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), env, ctx());

  const okRes = await post({ lines: [
    { variationId: "V_WAL", qty: 1, modifiers: ["M_HAND", "M_GLOSS"] },
    { variationId: "V_WAL", qty: 2 }
  ] });
  assert.equal(okRes.status, 200);
  assert.deepEqual(state.paymentLinks[0].order.line_items, [
    { catalog_object_id: "V_WAL", quantity: "1", modifiers: [{ catalog_object_id: "M_GLOSS" }, { catalog_object_id: "M_HAND" }] },
    { catalog_object_id: "V_WAL", quantity: "2" }
  ]);

  const overStock = await post({ lines: [{ variationId: "V_WAL", qty: 2, modifiers: ["M_HAND"] }, { variationId: "V_WAL", qty: 2 }] });
  assert.equal(overStock.status, 409, "three in stock, four asked for across two lines");
  assert.deepEqual(((await overStock.json()) as any).soldOut, ["V_WAL"]);

  for (const modifiers of [["M_NOPE"], ["M_SECRET"], ["M_OFF"], ["M_SATIN", "M_GLOSS"]]) {
    const bad = await post({ lines: [{ variationId: "V_WAL", qty: 1, modifiers }] });
    assert.equal(bad.status, 409, modifiers.join("+"));
    assert.deepEqual(((await bad.json()) as any).changed, ["V_WAL"]);
  }

  state.catalog[1].item_data.modifier_list_info[1].min_selected_modifiers = 1;
  assert.equal((await post({ lines: [{ variationId: "V_WAL", qty: 1 }] })).status, 409, "a required choice is missing");
  assert.equal((await post({ lines: [{ variationId: "V_WAL", qty: 1, modifiers: ["M_SATIN"] }] })).status, 200);
  assert.equal(state.paymentLinks.length, 2);
});

// The real page files from site/, served the way Cloudflare's static assets would.
const ASSETS = { fetch: async (req: Request) => {
  const path = new URL(req.url).pathname;
  const name = path.endsWith("/") ? path + "index.html" : path;
  try { return new Response(readFileSync(new URL("../../site" + name, import.meta.url), "utf8"), { headers: { "content-type": "text/html" } }); }
  catch { return new Response("static 404", { status: 404 }); }
} } as unknown as Fetcher;
const get = (env: Env, path: string) => worker.fetch(new Request("https://w.example" + path), env, ctx());

test("product pages are complete before any script runs", async () => {
  state.catalog[1].item_data.name = '"JAVA" TTRPG Dice Set';
  state.catalog[1].item_data.description_plaintext = "Coffee swirl dice.\n\nPrice is $55 & worth it <really>.";
  const env = makeEnv({ ASSETS, NOINDEX: undefined });

  const feed = (await (await get(env, "/api/products")).json()) as any;
  assert.deepEqual(feed.products.map((p: any) => p.slug).sort(), ["ember-dice-set", "java-ttrpg-dice-set"]);

  const res = await get(env, "/product/java-ttrpg-dice-set");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), null);
  const html = await res.text();
  assert.ok(html.includes("<title>&#34;JAVA&#34; TTRPG Dice Set · Golem Craftworks</title>"));
  assert.ok(html.includes('<link rel="canonical" href="https://golemcraftworks.com/product/java-ttrpg-dice-set">'));
  assert.ok(html.includes('<meta property="og:image" content="https://img/yz.jpg">'));
  assert.ok(html.includes("<h1>&#34;JAVA&#34; TTRPG Dice Set</h1>"));
  assert.ok(html.includes("<p>Price is $55 &#38; worth it &#60;really&#62;.</p>"), "description is in the page, escaped");
  assert.ok(!html.includes("ssr:") && !html.includes("skeleton"), "the placeholders are gone");
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.ok(html.includes('<script src="../js/product.js"></script>'), "the page script still loads");

  const data = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]);
  assert.equal(data["@type"], "Product");
  assert.equal(data.name, '"JAVA" TTRPG Dice Set');
  assert.deepEqual([data.offers["@type"], data.offers.lowPrice, data.offers.highPrice, data.offers.availability],
    ["AggregateOffer", "60.00", "65.00", "https://schema.org/InStock"]);
  assert.equal(data.offers.shippingDetails.shippingRate.value, "8.00");

  // One-of-a-kind and sold: the page stays up and says so.
  state.counts.V_DICE = 0;
  const sold = JSON.parse((await (await get(env, "/product/ember-dice-set")).text()).match(/ld\+json">(.*?)<\/script>/)![1]);
  assert.deepEqual([sold.offers["@type"], sold.offers.price, sold.offers.availability], ["Offer", "45.00", "https://schema.org/OutOfStock"]);

  const missing = await get(env, "/product/no-such-thing");
  assert.equal(missing.status, 404);
  assert.ok((await missing.text()).includes("This page wandered off."));
  assert.equal((await get(env, "/product/sticker")).status, 404, "hidden items have no page");
  const slash = await get(env, "/product/java-ttrpg-dice-set/");
  assert.deepEqual([slash.status, slash.headers.get("location")], [301, "https://w.example/product/java-ttrpg-dice-set"]);
  // The bare page (demo mode's ?id= address) is still the static file.
  assert.ok((await (await get(env, "/product/?id=I_YZ")).text()).includes("<!--ssr:product-->"));
});

test("home page shows a tile per category with something available", async () => {
  const env = makeEnv({ ASSETS });
  const html = await (await get(env, "/")).text();
  assert.ok(html.includes('<a href="/shop/dice">') && html.includes('<a href="/shop/game-sets">'));
  assert.ok(html.indexOf("/shop/dice") < html.indexOf("/shop/game-sets"), "A to Z");
  assert.ok(html.includes('<div class="cat__media" data-n="1"><img src="https://img/yz.jpg"') && html.includes("<p class=\"cat__count\">1 piece</p>"));
  assert.ok(!html.includes("/product/") && !html.includes("ssr:"), "products are on the category pages");
  assert.ok(html.includes("Hardwood boxes and dice, made one at a time."), "the rest of the page is intact");

  state.counts.V_DICE = 0;
  assert.ok(!(await (await get(env, "/")).text()).includes("/shop/dice"), "nothing available, no tile");
  // A category with few pieces fills its tile from their other photos.
  state.catalog[1].item_data.image_ids = ["IMG1", "IMG2", "IMG3"];
  state.related.push({ id: "IMG2", type: "IMAGE", image_data: { url: "https://img/yz2.jpg" } }, { id: "IMG3", type: "IMAGE", image_data: { url: "https://img/yz3.jpg" } });
  assert.ok((await (await get(env, "/")).text()).includes('data-n="3"><img src="https://img/yz.jpg" alt="" loading="lazy" decoding="async"><img src="https://img/yz2.jpg"'));

  // The old filter addresses lead to the category pages.
  const old = await get(env, "/?category=Game%20sets");
  assert.deepEqual([old.status, old.headers.get("location")], [301, "https://w.example/shop/game-sets"]);
  assert.equal((await get(env, "/?category=Gone")).headers.get("location"), "https://w.example/");
});

test("category pages list what's available; same-named items get distinct addresses", async () => {
  state.catalog[0].item_data.name = "Yahtzee set";
  state.catalog[0].item_data.categories = [{ id: "C_GAME" }];
  state.counts.V_DICE = 0;
  const env = makeEnv({ ASSETS, NOINDEX: undefined });
  const res = await get(env, "/shop/game-sets");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("<title>Game sets · Golem Craftworks</title>"));
  assert.ok(html.includes('<link rel="canonical" href="https://golemcraftworks.com/shop/game-sets">'));
  assert.ok(html.includes("Game sets: 1 handmade piece available now"));
  assert.ok(/<h1[^>]*>Game sets<\/h1>/.test(html) && html.includes('<a class="chip" href="/shop/game-sets" aria-current="page">Game sets</a>'));
  assert.ok(html.includes('<a href="/product/yahtzee-set-i_yz">') && html.includes(">From $60<"));
  assert.ok(!html.includes("/product/yahtzee-set-i_dice"), "the sold one isn't in the grid");
  assert.ok(!html.includes("ssr:") && html.includes('<script src="../js/shop.js"></script>'));
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal((await get(env, "/product/yahtzee-set-i_dice")).status, 200, "but its page is still there");
  assert.ok((await (await get(env, "/product/yahtzee-set-i_yz")).text()).includes('<a href="/shop/game-sets">Game sets</a>'));

  // Nothing in Square's categories: it goes under Other.
  state.catalog[0].item_data.categories = [];
  state.counts.V_DICE = 1;
  const other = await (await get(env, "/shop/other")).text();
  assert.ok(other.includes("<title>Other · Golem Craftworks</title>") && other.includes("/product/yahtzee-set-i_dice"));
  const home = await (await get(env, "/")).text();
  assert.ok(home.indexOf("/shop/game-sets") < home.indexOf("/shop/other"), "Other comes last");

  assert.equal((await get(env, "/shop/no-such-category")).status, 404);
  assert.equal((await get(env, "/shop/market-only")).status, 404, "hidden categories have no page");
  const slash = await get(env, "/shop/game-sets/");
  assert.deepEqual([slash.status, slash.headers.get("location")], [301, "https://w.example/shop/game-sets"]);
  // The bare page (demo mode's ?category= address) is still the static file.
  assert.ok((await (await get(env, "/shop/?category=Dice")).text()).includes("<!--ssr:grid-->"));
});

test("npm run dev without a Square token shows the sample products", async () => {
  const env = makeEnv({ ASSETS, DEMO_CATALOG: "true", SQUARE_ACCESS_TOKEN: "" });
  const home = await (await get(env, "/")).text();
  assert.ok(home.includes('<a href="/shop/8-piece-rpg-dice">') && home.includes('<a href="/shop/woodworks">') && home.includes('data-n="4"'));
  const wood = await (await get(env, "/shop/woodworks")).text();
  assert.ok(wood.includes('<a href="/product/yahtzee-set">'));
  assert.equal((await get(env, "/product/ember-ttrpg-dice-set")).status, 200);
  // With a token, the setting does nothing.
  assert.ok(!(await (await get(makeEnv({ ASSETS, DEMO_CATALOG: "true" }), "/")).text()).includes("/shop/woodworks"));
});

test("the shipping price comes from one setting, everywhere it's shown", async () => {
  const env = makeEnv({ ASSETS, SHIPPING_FLAT_CENTS: "950" });
  const config = await get(env, "/js/config.js");
  assert.ok((config.headers.get("content-type") || "").includes("javascript"));
  const js = await config.text();
  assert.ok(js.includes('shopName: "Golem Craftworks"') && js.trimEnd().endsWith("window.GC_CONFIG.shippingCents = 950;"));

  const shipping = await (await get(env, "/shipping/")).text();
  assert.ok(shipping.includes("for a flat $9.50, however many") && !shipping.includes("ssr:"));
  assert.ok((await (await get(env, "/llms.txt")).text()).includes("for a flat $9.50"));
  const product = await (await get(env, "/product/yahtzee-set")).text();
  assert.ok(product.includes('"shippingRate":{"@type":"MonetaryAmount","value":"9.50"'));

  await worker.fetch(new Request("https://w.example/api/checkout", { method: "POST", body: JSON.stringify({ lines: [{ variationId: "V_WAL", qty: 1 }] }) }), env, ctx());
  assert.equal(state.paymentLinks[0].checkout_options.shipping_fee.charge.amount, 950);
});

test("renaming an item in Square redirects its old address to the new one", async () => {
  const env = makeEnv({ ASSETS });
  const visit = async (path: string) => { const c = ctx(); const res = await worker.fetch(new Request("https://w.example" + path), env, c); await c.done(); return res; };
  assert.equal((await visit("/product/ember-dice-set")).status, 200);

  state.catalog[0].item_data.name = '"EMBER" TTRPG Dice Set';
  assert.equal((await visit("/product/ember-ttrpg-dice-set")).status, 200);
  const old = await visit("/product/ember-dice-set");
  assert.deepEqual([old.status, old.headers.get("location")], [301, "https://w.example/product/ember-ttrpg-dice-set"]);

  // Renamed again: both earlier addresses lead to the current one.
  state.catalog[0].item_data.name = "Ember";
  await visit("/");
  for (const path of ["/product/ember-dice-set", "/product/ember-ttrpg-dice-set"]) {
    assert.equal((await visit(path)).headers.get("location"), "https://w.example/product/ember", path);
  }
  assert.equal((await visit("/product/never-existed")).status, 404);
});

test("crawler files: sitemap, robots, llms.txt and the Google feed", async () => {
  const live = makeEnv({ ASSETS, NOINDEX: "false" });
  const map = await (await get(live, "/sitemap.xml")).text();
  for (const path of ["/", "/reviews/", "/shipping/", "/shop/dice", "/shop/game-sets", "/product/yahtzee-set", "/product/ember-dice-set"]) {
    assert.ok(map.includes(`<loc>https://golemcraftworks.com${path}</loc>`), path);
  }
  assert.ok(map.includes("<lastmod>2026-09-01</lastmod>") && !map.includes("sticker"));

  const robots = await (await get(live, "/robots.txt")).text();
  assert.ok(robots.includes("User-agent: GPTBot\nAllow: /") && robots.includes("Disallow: /admin/"));
  assert.ok(robots.includes("Sitemap: https://golemcraftworks.com/sitemap.xml"));

  const llms = await (await get(live, "/llms.txt")).text();
  assert.ok(llms.startsWith("# Golem Craftworks") && llms.includes("## Game sets"));
  assert.ok(llms.includes("- [Game sets](https://golemcraftworks.com/shop/game-sets)"));
  assert.ok(llms.includes("- [Yahtzee set](https://golemcraftworks.com/product/yahtzee-set): From $60, in stock."));

  const feed = await (await get(live, "/feeds/google.xml")).text();
  // Only items with a photo can be listed; one entry per wood, grouped.
  assert.equal((feed.match(/<item>/g) || []).length, 2);
  for (const part of ["<g:id>V_WAL</g:id>", "<g:title>Yahtzee set, Walnut</g:title>", "<g:price>65.00 USD</g:price>", "<g:availability>in_stock</g:availability>",
    "<g:id>V_CHE</g:id>", "<g:availability>out_of_stock</g:availability>", "<g:item_group_id>I_YZ</g:item_group_id>",
    "<g:link>https://golemcraftworks.com/product/yahtzee-set</g:link>", "<g:identifier_exists>no</g:identifier_exists>"]) {
    assert.ok(feed.includes(part), part);
  }

  // Before launch: everything is closed to search engines.
  const preview = makeEnv({ ASSETS, NOINDEX: "true" });
  assert.equal(await (await get(preview, "/robots.txt")).text(), "User-agent: *\nDisallow: /\n");
  assert.equal((await get(preview, "/product/yahtzee-set")).headers.get("x-robots-tag"), "noindex");
  assert.equal((await get(preview, "/")).headers.get("x-robots-tag"), "noindex");
});

test("if Square is unreachable, pages are built from the last saved catalog", async () => {
  const env = makeEnv({ ASSETS });
  const c = ctx();
  await worker.fetch(new Request("https://w.example/api/products"), env, c);
  await c.done(); // the catalog is saved in the background
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Square is down"); }) as typeof fetch;
  try {
    const res = await get(env, "/product/yahtzee-set");
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<h1>Yahtzee set</h1>"));
  } finally { globalThis.fetch = realFetch; }
});

test("catalog report: says why each Square item is or isn't on the site", async () => {
  state.catalog[0].is_deleted = true;
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request("https://w.example/admin/catalog"), env, ctx())).status, 404);
  const r = (await (await worker.fetch(new Request("https://w.example/admin/catalog?token=admintoken"), env, ctx())).json()) as any;
  assert.deepEqual(Object.fromEntries(r.items.map((i: any) => [i.name, i.status])), {
    "Ember dice set": "deleted in Square", "Yahtzee set": "on the site",
    "Sticker": "in a hidden category", "Archived thing": "archived in Square"
  });
  assert.deepEqual(r.totals, { "deleted in Square": 1, "on the site": 1, "in a hidden category": 1, "archived in Square": 1 });
  assert.deepEqual(r.items.find((i: any) => i.name === "Yahtzee set").skus, ["YZ-WAL", "YZ-CHE"]);
  assert.equal(calls.find((c) => c.url.endsWith("/v2/catalog/search"))!.body.include_deleted_objects, true);
});

test("admin endpoints require the token", async () => {
  const env = makeEnv();
  const no = await worker.fetch(new Request("https://w.example/admin/status"), env, ctx());
  assert.equal(no.status, 404);
  const yes = await worker.fetch(new Request("https://w.example/admin/status?token=admintoken"), env, ctx());
  assert.equal(yes.status, 200);
  assert.equal(((await yes.json()) as any).etsyConnected, true);
});
