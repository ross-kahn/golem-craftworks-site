import { test } from "node:test";
import assert from "node:assert/strict";
import { commission, isEmail, parseCommission } from "../src/commission.ts";
import type { Env } from "../src/types.ts";

const env = (extra: object = {}) => ({
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Golem Craftworks <commissions@golemcraftworks.com>",
  COMMISSION_TO: "golemcraftworks@gmail.com",
  SITE_URL: "https://golemcraftworks.com",
  ...extra
}) as Env;

const post = (body: unknown) => new Request("https://worker.test/api/commission", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

const valid = { name: "Jane Doe", email: "jane@example.com", type: "Dice vault", idea: "Walnut vault with initials." };

function fakeResend(failFor?: string) {
  const sent: any[] = [];
  globalThis.fetch = (async (_url: unknown, opts: { body: string }) => {
    const msg = JSON.parse(opts.body);
    if (failFor && msg.to[0] === failFor) return new Response("nope", { status: 422 });
    sent.push(msg);
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  return sent;
}

test("email validation", () => {
  for (const ok of ["jane@example.com", "a.b+tag@sub.example.co.uk", "x_y@ex-ample.io"]) assert.ok(isEmail(ok), ok);
  for (const bad of ["", "jane", "jane@", "@example.com", "jane@example", "jane@example.c", "ja ne@example.com",
    "jane@@example.com", "jane@example..com", "jane@-example.com", "jane@example.com, other@example.com", "<jane@example.com>"]) {
    assert.ok(!isEmail(bad), bad);
  }
});

test("newlines can't reach the subject line", () => {
  const { data } = parseCommission({ ...valid, name: "Jane\r\nBcc: x@y.com" });
  assert.equal(data.name, "Jane Bcc: x@y.com");
});

test("sends one email to the shop and one to the client", async () => {
  const sent = fakeResend();
  const res = await commission(post(valid), env());
  assert.deepEqual(await res.json(), { ok: true, confirmationSent: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].to, ["golemcraftworks@gmail.com"]);
  assert.equal(sent[0].subject, "New commission request: Dice vault (Jane Doe)");
  assert.equal(sent[0].reply_to, "jane@example.com");
  assert.deepEqual(sent[1].to, ["jane@example.com"]);
  assert.equal(sent[1].subject, "Golem Craftworks received your commission request");
  assert.equal(sent[1].reply_to, "golemcraftworks@gmail.com");
  assert.match(sent[1].text, /Walnut vault with initials\./);
});

test("rejects a bad email without sending anything", async () => {
  const sent = fakeResend();
  const res = await commission(post({ ...valid, email: "jane@example" }), env());
  assert.equal(res.status, 400);
  assert.equal(sent.length, 0);
});

test("a failed client confirmation still counts as sent", async () => {
  const sent = fakeResend("jane@example.com");
  const res = await commission(post(valid), env());
  assert.deepEqual(await res.json(), { ok: true, confirmationSent: false });
  assert.equal(sent.length, 1);
});

test("a failed shop email is an error and the client isn't told it worked", async () => {
  const sent = fakeResend("golemcraftworks@gmail.com");
  const res = await commission(post(valid), env());
  assert.equal(res.status, 502);
  assert.equal(sent.length, 0);
});

test("honeypot submissions send nothing", async () => {
  const sent = fakeResend();
  const res = await commission(post({ ...valid, website: "http://spam" }), env());
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
});

test("limits requests per visitor", async () => {
  fakeResend();
  const store = new Map<string, string>();
  const e = env({ GC_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } } });
  for (let i = 0; i < 5; i++) assert.equal((await commission(post(valid), e)).status, 200);
  assert.equal((await commission(post(valid), e)).status, 429);
});
