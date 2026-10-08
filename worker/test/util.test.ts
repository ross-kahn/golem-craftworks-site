// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { claim, isAdmin, overLimit, safeEqual, siteUrl } from "../src/util.ts";
import type { Env } from "../src/types.ts";

function kvEnv(extra: Partial<Env> = {}) {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const env = {
    GC_KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
        store.set(k, v);
        ttls.set(k, o?.expirationTtl);
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, store, ttls };
}

test("claim: the first to ask gets it, and it lapses after the time given", async () => {
  const { env, ttls } = kvEnv();
  assert.equal(await claim(env, "job:1", 120), true);
  assert.equal(await claim(env, "job:1", 120), false);
  assert.equal(await claim(env, "job:2", 120), true);
  assert.equal(ttls.get("job:1"), 120);
});

test("overLimit: counts up to each limit, then refuses without counting", async () => {
  const { env, store } = kvEnv();
  const limits = [
    ["visitor", 2],
    ["everyone", 3],
  ] as const;
  assert.equal(await overLimit(env, [...limits], 60), false);
  assert.equal(await overLimit(env, [...limits], 60), false);
  assert.equal(
    await overLimit(env, [...limits], 60),
    true,
    "the visitor's limit",
  );
  assert.deepEqual([store.get("visitor"), store.get("everyone")], ["2", "2"]);

  // Someone else still gets in until the shared limit fills.
  const other = [
    ["visitor-2", 2],
    ["everyone", 3],
  ] as const;
  assert.equal(await overLimit(env, [...other], 60), false);
  assert.equal(await overLimit(env, [...other], 60), true, "the shared limit");
  assert.equal(store.get("visitor-2"), "1");

  assert.equal(
    await overLimit({} as Env, [["x", 0]], 60),
    false,
    "no storage, no limit",
  );
});

test("admin addresses need the exact token, and one has to be set", () => {
  const url = (q: string) => new URL("https://shop.test/admin/status" + q);
  const env = { ADMIN_TOKEN: "s3cret" } as Env;
  assert.equal(isAdmin(env, url("?token=s3cret")), true);
  assert.equal(isAdmin(env, url("?token=s3cre")), false);
  assert.equal(isAdmin(env, url("?token=S3CRET")), false);
  assert.equal(isAdmin(env, url("")), false);
  assert.equal(isAdmin({} as Env, url("?token=")), false);
  assert.equal(isAdmin({ ADMIN_TOKEN: "" } as Env, url("?token=")), false);
  assert.equal(safeEqual(null, "x"), false);
});

test("siteUrl: SITE_URL without its slash, or else where the request came in", () => {
  const url = new URL("https://preview.shop.test/some/page");
  assert.equal(
    siteUrl({ SITE_URL: "https://shop.test/" } as Env, url),
    "https://shop.test",
  );
  assert.equal(siteUrl({} as Env, url), "https://preview.shop.test");
  assert.equal(siteUrl({} as Env), "");
});
