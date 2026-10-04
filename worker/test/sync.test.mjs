// Run with: node --test test/
// Exercises the Worker against fake Square and Etsy APIs (no network, no real accounts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import worker from "../src/index.js";
import * as square from "../src/square.js";
import { pushToEtsy, recordEtsyReceipt, reconcile, handleSquareInventoryEvent } from "../src/sync.js";

// ---------- fakes ----------
class KV {
  constructor() { this.m = new Map(); }
  async get(k, type) { const v = this.m.get(k); if (v === undefined) return null; return type === "json" ? JSON.parse(v) : v; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}
globalThis.caches = { default: { match: async () => null, put: async () => {}, delete: async () => true } };

let state, calls;
const LOC = "LOC1";

function freshState() {
  return {
    catalog: [
      item("I_DICE", "Ember dice set", [variation("V_DICE", "Default", 4500, "DICE-1", true)], { cat: "C_DICE" }),
      item("I_YZ", "Yahtzee set", [
        variation("V_WAL", "Walnut", 6500, "YZ-WAL", true),
        variation("V_CHE", "Cherry", 6000, "YZ-CHE", true)
      ], { cat: "C_GAME", image: "IMG1" }),
      item("I_STICKER", "Sticker", [variation("V_STK", "Default", 300, "STK", false)], { cat: "C_MISC" }),
      item("I_OLD", "Archived thing", [variation("V_OLD", "Default", 100, "OLD", true)], { archived: true })
    ],
    related: [
      { id: "C_DICE", type: "CATEGORY", category_data: { name: "Dice" } },
      { id: "C_GAME", type: "CATEGORY", category_data: { name: "Game sets" } },
      { id: "C_MISC", type: "CATEGORY", category_data: { name: "Market only" } },
      { id: "IMG1", type: "IMAGE", image_data: { url: "https://img/yz.jpg" } }
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

function item(id, name, variations, { cat, image, archived } = {}) {
  return { id, type: "ITEM", updated_at: "2026-09-01T00:00:00Z", present_at_all_locations: true,
    item_data: { name, description_plaintext: `${name} description`, is_archived: !!archived,
      categories: cat ? [{ id: cat }] : [], image_ids: image ? [image] : [], variations } };
}
function variation(id, name, price, sku, track) {
  return { id, type: "ITEM_VARIATION", present_at_all_locations: true,
    item_variation_data: { name, sku, price_money: { amount: price, currency: "USD" }, pricing_type: "FIXED_PRICING", track_inventory: track } };
}
function inv(rows) {
  return {
    products: rows.map(([sku, qty, enabled, valueId], i) => ({
      product_id: 9000 + i, sku, is_deleted: false,
      property_values: valueId ? [{ property_id: 200, property_name: "Wood", scale_id: null, scale_name: null, value_ids: [valueId], values: [sku] }] : [],
      offerings: [{ offering_id: 7000 + i, quantity: qty, is_enabled: enabled, is_deleted: false, price: { amount: 6500, divisor: 100, currency_code: "USD" } }]
    })),
    price_on_property: [], quantity_on_property: rows.length > 1 ? [200] : [], sku_on_property: rows.length > 1 ? [200] : []
  };
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const method = init.method || "GET";
  const body = init.body && init.headers && String(init.headers["content-type"]).includes("json") ? JSON.parse(init.body) : init.body;
  calls.push({ method, url, body });

  // ---- Square ----
  if (url.endsWith("/v2/catalog/search")) {
    if (body.object_types[0] === "ITEM_VARIATION") {
      const sku = body.query.exact_query.attribute_value;
      const v = state.catalog.flatMap((i) => i.item_data.variations).find((x) => x.item_variation_data.sku === sku);
      return ok({ objects: v ? [v] : [] });
    }
    return ok({ objects: state.catalog, related_objects: state.related });
  }
  if (url.endsWith("/v2/catalog/batch-retrieve")) {
    const all = state.catalog.flatMap((i) => i.item_data.variations);
    return ok({ objects: all.filter((v) => body.object_ids.includes(v.id)) });
  }
  if (url.endsWith("/v2/inventory/counts/batch-retrieve")) {
    return ok({ counts: body.catalog_object_ids.filter((id) => id in state.counts)
      .map((id) => ({ catalog_object_id: id, location_id: LOC, state: "IN_STOCK", quantity: String(state.counts[id]) })) });
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
    let m;
    if ((m = url.match(/\/shops\/\d+\/listings\?state=(\w+)/))) {
      return ok({ count: 0, results: Object.values(state.listings).filter((l) => l.state === m[1]) });
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
};

function makeEnv(extra = {}) {
  const kv = new KV();
  kv.m.set("etsy:tokens", JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_at: Date.now() + 3600e3 }));
  return {
    GC_KV: kv, SQUARE_ACCESS_TOKEN: "sq", SQUARE_LOCATION_ID: LOC, SQUARE_ENV: "sandbox",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "sigkey", SQUARE_WEBHOOK_URL: "https://w.example/webhooks/square",
    ETSY_KEYSTRING: "KEY", ETSY_SHARED_SECRET: "SECRET", ETSY_SHOP_ID: "55",
    ETSY_WEBHOOK_SECRET: "whsec_" + Buffer.from("etsy-secret-bytes").toString("base64"),
    SITE_URL: "https://golemcraftworks.com", ALLOWED_ORIGINS: "https://golemcraftworks.com",
    SHIPPING_FLAT_CENTS: "800", HIDDEN_CATEGORIES: "Market only", ADMIN_TOKEN: "admintoken",
    SYNC_DRY_RUN: "false", ...extra
  };
}
const ctx = () => { const p = []; return { waitUntil: (x) => p.push(x), done: () => Promise.all(p) }; };

beforeEach(() => { state = freshState(); calls = []; });

// ---------- tests ----------

test("storefront: hides archived and hidden-category items, keeps stock and untracked items", async () => {
  const { products, skuMap, tracked } = await square.buildStorefront(makeEnv());
  assert.deepEqual(products.map((p) => p.name).sort(), ["Ember dice set", "Yahtzee set"]);
  const yz = products.find((p) => p.id === "I_YZ");
  assert.equal(yz.category, "Game sets");
  assert.deepEqual(yz.images, ["https://img/yz.jpg"]);
  assert.deepEqual(yz.variations.map((v) => [v.name, v.qty, v.priceCents]), [["Walnut", 3, 6500], ["Cherry", 0, 6000]]);
  assert.equal(skuMap["STK"], "V_STK", "hidden items still map for Etsy sales");
  assert.equal(tracked.has("V_STK"), false);
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
  const che = put.products.find((p) => p.sku === "YZ-CHE");
  assert.deepEqual(che.offerings, [{ price: 65, quantity: 0, is_enabled: false }]);
  assert.equal("product_id" in che, false);
  assert.equal("offering_id" in che.offerings[0], false);
  assert.deepEqual(che.property_values[0].value_ids, [514]);
  const wal = put.products.find((p) => p.sku === "YZ-WAL");
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
  const log = await env.GC_KV.get("log", "json");
  assert.match(log[0].message, /DRY RUN/);
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
  const post = (b) => worker.fetch(new Request("https://w.example/api/checkout", {
    method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", origin: "https://golemcraftworks.com" } }), env, ctx());

  const sold = await post({ lines: [{ variationId: "V_CHE", qty: 1 }], fulfillment: "ship" });
  assert.equal(sold.status, 409);
  assert.deepEqual((await sold.json()).soldOut, ["V_CHE"]);

  const okRes = await post({ lines: [{ variationId: "V_WAL", qty: 2 }, { variationId: "V_DICE", qty: 1 }], fulfillment: "ship" });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("access-control-allow-origin"), "https://golemcraftworks.com");
  assert.equal((await okRes.json()).url, "https://square.link/u/abc");
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
});

test("admin endpoints require the token", async () => {
  const env = makeEnv();
  const no = await worker.fetch(new Request("https://w.example/admin/status"), env, ctx());
  assert.equal(no.status, 404);
  const yes = await worker.fetch(new Request("https://w.example/admin/status?token=admintoken"), env, ctx());
  assert.equal(yes.status, 200);
  assert.equal((await yes.json()).etsyConnected, true);
});
