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

let kv: KV, sent: any[], etsyCalls: string[], turnstileOk: boolean;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

globalThis.fetch = (async (input: unknown, init: any = {}) => {
  const url = String(input);
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.includes("api.resend.com")) { sent.push(JSON.parse(init.body)); return ok({ id: "x" }); }
  if (url.includes("turnstile")) return ok({ success: turnstileOk });
  if (url.includes("openapi.etsy.com")) {
    etsyCalls.push(url);
    assert.equal(init.headers["x-api-key"], "KEY:SECRET");
    if (url.endsWith("/shops/55")) return ok({ transaction_sold_count: 1480, review_count: 3, review_average: 4.6667 });
    if (url.includes("/shops/55/reviews")) return ok({ results: [
      { transaction_id: 1, rating: 5, review: "Gorgeous dice.", create_timestamp: 1750000000, image_url_fullxfull: "https://i.etsystatic.com/a.jpg" },
      { transaction_id: 2, rating: 4, review: "", create_timestamp: 1751000000 },
      { transaction_id: 3, rating: 5, review: " Fast shipping ", create_timestamp: 1752000000 }
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
const ctx = () => ({ waitUntil: () => {} });
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

beforeEach(() => { kv = new KV(); sent = []; etsyCalls = []; turnstileOk = true; });

test("reviews: nothing set up yet means an empty list, not an error", async () => {
  const data = await listed(makeEnv());
  assert.deepEqual(data, { reviews: [], stats: { count: 0, average: null, etsySales: null } });
  assert.equal(etsyCalls.length, 0, "placeholder Etsy settings are not called");
});

test("reviews: a submitted review is held for approval and the email is only ever emailed", async () => {
  const env = makeEnv();
  const res = await submit(env, reviewForm({}, [JPEG]));
  assert.equal(res.status, 200);
  assert.equal((await listed(env)).reviews.length, 0, "not public until approved");

  // The shop gets the address as reply-to; storage never sees it.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply_to, "jane@example.com");
  assert.deepEqual(sent[0].to, ["shop@example.com"]);
  for (const [k, v] of kv.m) assert.ok(typeof v !== "string" || !v.includes("jane@example.com"), `email found in ${k}`);

  const record = JSON.parse(kv.m.get(stored()[0]) as string);
  const link = `/admin/review?id=${record.id}&key=${record.key}`;
  assert.ok(sent[0].text.includes("https://golemcraftworks.com" + link));

  // The photo is private until approval, and opening the link changes nothing.
  assert.equal((await call(env, `/api/reviews/photo/${record.id}/0`)).status, 404);
  assert.equal((await call(env, `/api/reviews/photo/${record.id}/0?key=${record.key}`)).status, 200);
  assert.equal((await call(env, link)).status, 200);
  assert.equal((await listed(env)).reviews.length, 0);
  assert.equal((await call(env, `/admin/review?id=${record.id}&key=wrong`)).status, 404);

  const act = (action: string) => call(env, "/admin/review", { method: "POST", body: new URLSearchParams({ id: record.id, key: record.key, action }) });
  await act("approve");
  const data = await listed(env);
  assert.deepEqual(data.reviews.map((r: any) => [r.source, r.name, r.rating, r.text, r.product, r.photos]),
    [["site", "Jane", 5, "Love the vault.", "Dice vault", [`/api/reviews/photo/${record.id}/0`]]]);
  assert.deepEqual(data.stats, { count: 1, average: 5, etsySales: null });
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
  assert.ok(page.includes("Love the vault.") && page.includes("pending"));
});

test("reviews: Etsy reviews and the sales count are merged in once the Etsy key is set", async () => {
  const env = makeEnv({ ETSY_KEYSTRING: "KEY", ETSY_SHARED_SECRET: "SECRET", ETSY_SHOP_ID: "55" });
  const data = await listed(env);
  assert.deepEqual(data.stats, { count: 3, average: 4.7, etsySales: 1480 });
  // The star-only review has nothing to show; newest first.
  assert.deepEqual(data.reviews.map((r: any) => [r.id, r.source, r.name, r.text, r.photos]), [
    ["etsy-3", "etsy", "Etsy buyer", "Fast shipping", []],
    ["etsy-1", "etsy", "Etsy buyer", "Gorgeous dice.", ["https://i.etsystatic.com/a.jpg"]]
  ]);
  const calls = etsyCalls.length;
  await listed(env);
  assert.equal(etsyCalls.length, calls, "second read comes from the stored copy");
});
