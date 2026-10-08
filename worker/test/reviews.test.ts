// Run with: npm test
// Reviews against fake Etsy, Resend and Turnstile (no network, no real accounts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

class KV {
  m = new Map<string, string | ArrayBuffer>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v as string) : v;
  }
  async put(k: string, v: string | ArrayBuffer) { this.m.set(k, v); }
  async delete(k: string) { this.m.delete(k); }
  async list({ prefix }: { prefix: string }) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}
(globalThis as any).caches = { default: { match: async () => null, put: async () => {}, delete: async () => true } };

let kv: KV, sent: any[], etsyCalls: string[], squareCalls: any[], squareDown: boolean, resendDown: boolean, turnstileOk: boolean;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

globalThis.fetch = (async (input: unknown, init: any = {}) => {
  const url = String(input);
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.includes("api.resend.com")) {
    if (resendDown) return new Response("down", { status: 500 });
    sent.push(JSON.parse(init.body)); return ok({ id: "x" });
  }
  if (url.includes("turnstile")) return ok({ success: turnstileOk });
  if (url.includes("openapi.etsy.com")) {
    etsyCalls.push(url);
    assert.equal(init.headers["x-api-key"], "KEY:SECRET");
    if (url.endsWith("/shops/55")) return ok({ transaction_sold_count: 1480, review_count: 3, review_average: 4.6667 });
    if (url.includes("/shops/55/reviews")) return ok({ results: [
      { transaction_id: 1, rating: 5, review: "Can&#39;t wait to gift these for D&D. &quot;Gorgeous&quot; &amp; sharp.", create_timestamp: 1750000000, image_url_fullxfull: "https://i.etsystatic.com/a.jpg" },
      { transaction_id: 2, rating: 4, review: "", create_timestamp: 1751000000 },
      { transaction_id: 3, rating: 5, review: " Fast shipping ", create_timestamp: 1752000000 }
    ] });
  }
  if (url.endsWith("/v2/orders/ORDER1")) return ok({ order: {
    line_items: [{ name: "Dice vault", variation_name: "Walnut", quantity: "1", modifiers: [{ name: "Engraving" }], gross_sales_money: { amount: 6500 }, total_money: { amount: 7020 } }],
    fulfillments: [{ shipment_details: { recipient: { display_name: "Jane Doe", phone_number: "555-0100" } } }],
    service_charges: [{ name: "Shipping", amount_money: { amount: 800 } }],
    total_tax_money: { amount: 520 },
    total_money: { amount: 7820 }
  } });
  if (url.includes("/v2/payments?")) return ok({ payments: recentPayments });
  if (url.includes("/v2/orders/search")) {
    squareCalls.push(JSON.parse(init.body));
    if (squareDown) return new Response("{}", { status: 500 });
    return ok({ orders: [
      { state: "COMPLETED", tenders: [{}], line_items: [{ quantity: "2" }, { quantity: "1" }] },
      { state: "OPEN", tenders: [{}], line_items: [{ quantity: "1" }] }, // paid website order, not shipped yet
      { state: "OPEN", line_items: [{ quantity: "5" }] }, // unpaid
      { state: "COMPLETED", returns: [{ return_line_items: [{ quantity: "1" }] }] }
    ] });
  }
  throw new Error("Unexpected fetch " + url);
}) as typeof fetch;

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    GC_KV: kv as unknown as KVNamespace, SQUARE_ACCESS_TOKEN: "sq", SQUARE_LOCATION_ID: "LOC1",
    ETSY_KEYSTRING: "REPLACE_ME", ETSY_SHOP_ID: "REPLACE_ME", ETSY_SHARED_SECRET: "",
    SITE_URL: "https://golemcraftworks.com", ADMIN_TOKEN: "admintoken",
    RESEND_API_KEY: "re_test", EMAIL_FROM: "Golem Craftworks <reviews@golemcraftworks.com>", COMMISSION_TO: "shop@example.com",
    ...extra
  };
}
// Work the Worker finishes after it has answered; settle() waits for it.
const pending: Promise<unknown>[] = [];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
const settle = () => Promise.all(pending.splice(0));
let recentPayments: object[] = [];
const call = (env: Env, path: string, init?: RequestInit) => worker.fetch(new Request("https://w.example" + path, init), env, ctx());

function reviewForm(over: Record<string, string> = {}, photos: Uint8Array[] = []) {
  const f = new FormData();
  const fields = { name: "Jane", email: "jane@example.com", rating: "5", text: "Love the vault.", product: "Dice vault", elapsed: "20000", website: "", ...over };
  Object.entries(fields).forEach(([k, v]) => f.set(k, v));
  photos.forEach((p) => f.append("photos", new Blob([p], { type: "image/jpeg" }), "photo.jpg"));
  return f;
}
const submit = (env: Env, form: FormData, ip = "1.1.1.1") => call(env, "/api/reviews", { method: "POST", body: form, headers: { "cf-connecting-ip": ip } });
const listed = async (env: Env) => (await (await call(env, "/api/reviews")).json()) as any;
const stored = () => [...kv.m.keys()].filter((k) => k.startsWith("review:item:"));

beforeEach(() => { kv = new KV(); sent = []; etsyCalls = []; squareCalls = []; squareDown = false; resendDown = false; turnstileOk = true; });

test("reviews: nothing set up yet means an empty list, not an error", async () => {
  const data = await listed(makeEnv());
  assert.deepEqual(data, { reviews: [], stats: { count: 0, average: null, sales: null } });
  assert.equal(etsyCalls.length, 0, "placeholder Etsy settings are not called");
});

test("reviews: a submitted review shows straight away, can be taken down, and the email is only ever emailed", async () => {
  const env = makeEnv();
  const res = await submit(env, reviewForm({}, [JPEG]));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).review.text, "Love the vault.");
  assert.equal((await listed(env)).reviews.length, 1, "public without approval");

  // The shop gets the address as reply-to; storage never sees it.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply_to, "jane@example.com");
  assert.deepEqual(sent[0].to, ["shop@example.com"]);
  for (const [k, v] of kv.m) assert.ok(typeof v !== "string" || !v.includes("jane@example.com"), `email found in ${k}`);

  const record = JSON.parse(kv.m.get(stored()[0]) as string);
  const link = `/admin/review?id=${record.id}&key=${record.key}`;
  assert.ok(sent[0].text.includes("https://golemcraftworks.com" + link));
  assert.ok(sent[0].text.includes("showing on the site now"));

  // Opening the link changes nothing: taking a review down needs a button press.
  assert.equal((await call(env, link)).status, 200);
  assert.equal((await listed(env)).reviews.length, 1);
  assert.equal((await call(env, `/admin/review?id=${record.id}&key=wrong`)).status, 404);

  // Hidden: off the site, photo private again. Shown: back.
  const act = (action: string) => call(env, "/admin/review", { method: "POST", body: new URLSearchParams({ id: record.id, key: record.key, action }) });
  await act("hide");
  assert.equal((await listed(env)).reviews.length, 0);
  assert.equal((await call(env, `/api/reviews/photo/${record.id}/0`)).status, 404);
  assert.equal((await call(env, `/api/reviews/photo/${record.id}/0?key=${record.key}`)).status, 200);
  await act("approve");
  const data = await listed(env);
  assert.deepEqual(data.reviews.map((r: any) => [r.source, r.name, r.rating, r.text, r.product, r.photos]),
    [["site", "Jane", 5, "Love the vault.", "Dice vault", [`/api/reviews/photo/${record.id}/0`]]]);
  assert.deepEqual(data.stats, { count: 1, average: 5, sales: null });
  const img = await call(env, `/api/reviews/photo/${record.id}/0`);
  assert.equal(img.headers.get("content-type"), "image/jpeg");
  assert.equal(new Uint8Array(await img.arrayBuffer()).length, JPEG.length);

  await act("delete");
  assert.equal((await listed(env)).reviews.length, 0);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith("review:item:") || k.startsWith("review:photo:")).length, 0);
});

test("reviews: bots, bad input and floods are turned away", async () => {
  const env = makeEnv();
  // Honeypot filled, or sent instantly: looks accepted, nothing kept.
  assert.equal((await submit(env, reviewForm({ website: "http://spam" }))).status, 200);
  assert.equal((await submit(env, reviewForm({ elapsed: "200" }))).status, 200);
  assert.equal(stored().length, 0);
  assert.equal(sent.length, 0);

  const invalid: Record<string, string>[] = [{ name: "" }, { email: "nope" }, { rating: "6" }, { rating: "" }, { text: " " }];
  for (const bad of invalid) {
    assert.equal((await submit(env, reviewForm(bad))).status, 400, JSON.stringify(bad));
  }
  const notAnImage = new TextEncoder().encode("<script>alert(1)</script>");
  assert.equal((await submit(env, reviewForm({}, [notAnImage]))).status, 400);
  assert.equal((await submit(env, reviewForm({}, [JPEG, JPEG, JPEG, JPEG]))).status, 400);
  assert.equal(stored().length, 0);

  // Spam check, once it's configured.
  const guarded = makeEnv({ TURNSTILE_SECRET: "ts" });
  turnstileOk = false;
  assert.equal((await submit(guarded, reviewForm({ "cf-turnstile-response": "tok" }))).status, 403);
  turnstileOk = true;
  assert.equal((await submit(guarded, reviewForm())).status, 403, "no token at all");
  assert.equal((await submit(guarded, reviewForm({ "cf-turnstile-response": "tok" }), "9.9.9.9")).status, 200);

  // A review with a link in it is kept but hidden until it's looked at.
  const before = sent.length;
  const spam = await submit(env, reviewForm({ text: "Great dice, see www.cheap-pills.example" }), "3.3.3.3");
  assert.deepEqual(await spam.json(), { ok: true });
  assert.ok(!JSON.stringify(await listed(env)).includes("cheap-pills"));
  assert.ok(sent[before].subject.startsWith("New review to check") && sent[before].text.includes("hidden until you show it"));

  // Three a day per visitor.
  for (let i = 0; i < 3; i++) assert.equal((await submit(env, reviewForm(), "2.2.2.2")).status, 200);
  assert.equal((await submit(env, reviewForm(), "2.2.2.2")).status, 429);
});

test("reviews: without email set up the review is still kept, and the admin list needs the token", async () => {
  const env = makeEnv({ RESEND_API_KEY: undefined });
  assert.equal((await submit(env, reviewForm())).status, 200);
  assert.equal(stored().length, 1);
  assert.ok(!JSON.stringify(await kv.get("log", "json")).includes("jane@example.com"));
  assert.equal((await call(env, "/admin/reviews")).status, 404);
  const page = await (await call(env, "/admin/reviews?token=admintoken")).text();
  assert.ok(page.includes("Love the vault.") && page.includes("showing"));
});

test("reviews: Etsy reviews and the sales count are merged in once the Etsy key is set", async () => {
  const env = makeEnv({ ETSY_KEYSTRING: "KEY", ETSY_SHARED_SECRET: "SECRET", ETSY_SHOP_ID: "55" });
  const data = await listed(env);
  assert.deepEqual(data.stats, { count: 3, average: 4.7, sales: 1480 });
  // The star-only review has nothing to show; newest first.
  assert.deepEqual(data.reviews.map((r: any) => [r.id, r.source, r.name, r.text, r.photos]), [
    ["etsy-3", "etsy", "Etsy buyer", "Fast shipping", []],
    ["etsy-1", "etsy", "Etsy buyer", `Can't wait to gift these for D&D. "Gorgeous" & sharp.`, ["https://i.etsystatic.com/a.jpg"]]
  ]);
  const calls = etsyCalls.length;
  await listed(env);
  assert.equal(etsyCalls.length, calls, "second read comes from the stored copy");

  // A copy saved before the text was cleaned up is refetched rather than shown.
  await kv.put("reviews:etsy", JSON.stringify({ at: Date.now(), sales: 1, count: 1, average: 5, reviews: [{ id: "etsy-9", source: "etsy", name: "Etsy buyer", rating: 5, text: "can&#39;t", product: "", photos: [], at: "2026-01-01T00:00:00Z" }] }));
  assert.ok(!JSON.stringify(await listed(env)).includes("&#39;"));
});

test("reviews: Square sales since the cutoff date are added to Etsy's sales count", async () => {
  const etsy = { ETSY_KEYSTRING: "KEY", ETSY_SHARED_SECRET: "SECRET", ETSY_SHOP_ID: "55" };
  const env = makeEnv({ ...etsy, SQUARE_SALES_SINCE: "2026-10-04" });
  // 3 + 1 paid, the unpaid order ignored, 1 returned.
  assert.equal((await listed(env)).stats.sales, 1480 + 3);
  assert.deepEqual(squareCalls[0].location_ids, ["LOC1"]);
  assert.equal(squareCalls[0].query.filter.date_time_filter.created_at.start_at, "2026-10-04T00:00:00.000Z");

  // Square being down keeps the last count rather than dropping it.
  squareDown = true;
  const { refreshEtsyReviews } = await import("../src/reviews.ts");
  assert.equal((await refreshEtsyReviews(env))?.squareSales, 3);

  // No cutoff date: Etsy's figure alone, and Square isn't asked.
  kv = new KV(); squareCalls = [];
  assert.equal((await listed(makeEnv(etsy))).stats.sales, 1480);
  assert.equal(squareCalls.length, 0);
});

test("sales: a paid website order emails the shop once; in-person sales don't; a failed email is retried", async () => {
  const { createHmac } = await import("node:crypto");
  const env = makeEnv({ SQUARE_WEBHOOK_SIGNATURE_KEY: "sigkey", SQUARE_WEBHOOK_URL: "https://w.example/webhooks/square", SALES_TO: "sales@example.com" });
  const hook = async (id: string, payment: object, type = "payment.updated") => {
    const raw = JSON.stringify({ event_id: id, type, data: { object: { payment } } });
    const sig = createHmac("sha256", "sigkey").update(env.SQUARE_WEBHOOK_URL + raw).digest("base64");
    const res = await call(env, "/webhooks/square", { method: "POST", body: raw, headers: { "x-square-hmacsha256-signature": sig } });
    await settle();
    return res;
  };
  const paid = {
    status: "COMPLETED", order_id: "ORDER1", note: "Website order: ship", buyer_email_address: "jane@example.com", total_money: { amount: 7820 },
    processing_fee: [{ amount_money: { amount: 257 } }], receipt_url: "https://squareup.com/receipt/x", receipt_number: "ox1B", created_at: "2026-10-07T23:05:00Z",
    shipping_address: { first_name: "Jane", last_name: "Doe", address_line_1: "1 Main St", locality: "Ithaca", administrative_district_level_1: "NY", postal_code: "14850", country: "US" }
  };

  await hook("e0", { ...paid, status: "APPROVED" }, "payment.created");
  await hook("e1", { ...paid, note: "" }); // rung up in person
  assert.equal(sent.length, 0);

  assert.equal((await hook("e2", paid)).status, 200);
  await hook("e3", paid); // Square reports the same payment again
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["sales@example.com"]);
  assert.equal(sent[0].reply_to, "jane@example.com");
  assert.equal(sent[0].subject, "💲You got a sale! Dice vault #ox1B (ship)");
  for (const part of ["SHIP TO:\nJane Doe\n1 Main St\nIthaca, NY 14850", "Buyer: Jane Doe · jane@example.com · 555-0100", "1 x Dice vault (Walnut, Engraving)  $65.00",
    "Shipping:     $8.00", "Sales tax:    $5.20", "Total paid:   $78.20", "Square fee:   -$2.57", "You receive:  $75.63", "https://squareup.com/receipt/x", "ORDER1", "Ordered: Oct 7, 2026, 6:05 PM Central", "Receipt: #ox1B"]) {
    assert.ok(sent[0].text.includes(part), part);
  }

  // Email down: Square is still answered at once, and the hourly check sends the email it finds missing, once.
  kv = new KV(); env.GC_KV = kv as unknown as KVNamespace; sent = [];
  const pickup = { ...paid, note: "Website order: LOCAL PICKUP", processing_fee: undefined };
  resendDown = true;
  assert.equal((await hook("e4", pickup)).status, 200);
  assert.equal(sent.length, 0);
  assert.match(JSON.stringify(await kv.get("log", "json")), /WEBSITE ORDER: the email to the shop failed/);
  resendDown = false;
  const { mailMissedSales } = await import("../src/sales.ts");
  recentPayments = [pickup, { ...paid, note: "" }];
  await mailMissedSales(env);
  await mailMissedSales(env);
  recentPayments = [];
  assert.equal(sent.length, 1);
  assert.ok(sent[0].subject.endsWith("(pickup)") && sent[0].text.startsWith("LOCAL PICKUP"));
  assert.ok(sent[0].text.includes("Square fee:   not posted yet") && !sent[0].text.includes("SHIP TO"));
  assert.ok(!sent[0].text.includes("WISCONSIN ORDER"), "tax was collected on this one");
});

test("daily report: quiet when all is well, one email when something needs a look, SKUs mentioned once", async () => {
  const env = makeEnv({ SALES_TO: "sales@example.com" });
  const report = () => call(env, "/admin/report?token=admintoken", { method: "POST" }).then((r) => r.json()) as Promise<any>;
  const check = (extra: object = {}) => kv.put("status:last-reconcile", JSON.stringify({
    at: new Date().toISOString(), etsySalesChecked: 0, changed: [], notPublished: [], squareOnly: [], etsyOnly: [], errors: [], ...extra }));
  await kv.put("etsy:tokens", JSON.stringify({ access_token: "a" }));
  await check();
  assert.equal((await report()).sent, false);
  assert.equal(sent.length, 0);

  await check({
    errors: ["listing 5: Etsy said no"], etsyOnly: ["yahtzee-walnut"],
    notPublished: [{ listing: 101, title: "Ember", state: "inactive", square: 2 }]
  });
  const old = new Date(Date.now() - 2 * 86400000).toISOString(), recent = new Date().toISOString();
  await kv.put("log", JSON.stringify([
    { at: recent, message: "Etsy update failed", data: { error: "boom" } },
    { at: recent, message: "Etsy update failed", data: { error: "older boom" } },
    { at: recent, message: "Updated Etsy to match Square" },
    { at: old, message: "Hourly check failed" }
  ]));
  assert.equal((await report()).sent, true);
  assert.deepEqual(sent[0].to, ["sales@example.com"]);
  assert.equal(sent[0].subject, "Golem Craftworks sync: 4 things need a look");
  for (const part of ["listing 5: Etsy said no", "Ember: 2 in Square, Inactive on Etsy", "yahtzee-walnut", "Etsy update failed (2 times): boom"]) {
    assert.ok(sent[0].text.includes(part), part);
  }
  assert.ok(!sent[0].text.includes("Hourly check failed") && !sent[0].text.includes("Updated Etsy"));

  // Next day, the same SKU isn't repeated; a check that has stopped running is.
  await kv.put("log", "[]");
  await check({ etsyOnly: ["yahtzee-walnut"], at: new Date(Date.now() - 5 * 3600000).toISOString() });
  await report();
  assert.ok(sent[1].text.includes("hasn't run lately") && !sent[1].text.includes("yahtzee-walnut"));
});

test("sales: a Wisconsin order with no tax collected is pointed out; an out-of-state one isn't", async () => {
  const { notifySale } = await import("../src/sales.ts");
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: any) => String(input).endsWith("/v2/orders/ORDER1")
    ? new Response(JSON.stringify({ order: { line_items: [{ name: "Dice", quantity: "1", total_money: { amount: 4000 } }], total_money: { amount: 4000 } } }))
    : real(input as any, init)) as typeof fetch;
  try {
    const env = makeEnv();
    const event = (state: string) => ({ data: { object: { payment: {
      status: "COMPLETED", order_id: "ORDER1", note: "Website order: ship", total_money: { amount: 4000, currency: "USD" },
      shipping_address: { address_line_1: "1 Main St", locality: "Town", administrative_district_level_1: state, postal_code: "53703" }
    } } } });
    await notifySale(env, event("WI"));
    assert.ok(sent[0].text.includes("WISCONSIN ORDER (shipped in state)"));
    kv = new KV(); env.GC_KV = kv as unknown as KVNamespace;
    await notifySale(env, event("MN"));
    assert.ok(!sent[1].text.includes("WISCONSIN ORDER"));
  } finally { globalThis.fetch = real; }
});

test("sales: a wallet payment's address is picked up from the order once Square attaches it, or from the customer", async () => {
  const { notifySale } = await import("../src/sales.ts");
  const real = globalThis.fetch;
  const address = { address_line_1: "9 Elm St", locality: "Duluth", administrative_district_level_1: "MN", postal_code: "55802" };
  let orderReads = 0, onOrder = true;
  globalThis.fetch = (async (input: unknown, init: any) => {
    const url = String(input);
    const ok = (b: unknown) => new Response(JSON.stringify(b));
    if (url.endsWith("/v2/payments/PAY1")) return ok({ payment: event.data.object.payment });
    if (url.endsWith("/v2/customers/CUST1")) return ok({ customer: { given_name: "Sam", family_name: "Lee", phone_number: "555-0199", address } });
    if (url.endsWith("/v2/orders/ORDER1")) {
      orderReads++;
      // Not there on the first read: Square adds it a moment later.
      const recipient = { display_name: "Sam Lee", phone_number: "555-0199", address };
      return ok({ order: { customer_id: "CUST1", line_items: [{ name: "Dice", quantity: "1" }], fulfillments: onOrder && orderReads > 1 ? [{ shipment_details: { recipient } }] : [] } });
    }
    return real(input as any, init);
  }) as typeof fetch;
  const event = { data: { object: { payment: { id: "PAY1", status: "COMPLETED", order_id: "ORDER1", note: "Website order: ship", total_money: { amount: 4000, currency: "USD" },
    shipping_address: { first_name: "Sam", last_name: "Lee" } } } } }; // as a real Google Pay payment arrives: a name and no street
  try {
    const env = makeEnv();
    await notifySale(env, event, 1);
    assert.equal(orderReads, 2);
    assert.ok(sent[0].text.includes("SHIP TO:\nSam Lee\n9 Elm St\nDuluth, MN 55802") && sent[0].text.includes("555-0199"));

    kv = new KV(); env.GC_KV = kv as unknown as KVNamespace; onOrder = false;
    await notifySale(env, event, 1);
    assert.ok(sent[1].text.includes("SHIP TO (from the buyer's customer record in Square; check it against the order):\nSam Lee\n9 Elm St"));
  } finally { globalThis.fetch = real; }
});
