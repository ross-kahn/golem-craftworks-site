// Run with: npm test
// The whole shop in a pretend browser (happy-dom): the Worker serves the real pages and scripts from
// site/, with the sample products from worker/src/demo-products.json, and the tests click through them.
// Nothing here knows how the scripts are organised, only what a visitor sees.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Browser } from "happy-dom";
import worker from "../src/index.ts";
import type { Env } from "../src/types.ts";

const SITE = "https://shop.test";
const TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
};

class KV {
  m = new Map<string, string>();
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k: string, v: string) {
    this.m.set(k, v);
  }
  async delete(k: string) {
    this.m.delete(k);
  }
  async list() {
    return {
      keys: [...this.m.keys()].map((name) => ({ name })),
      list_complete: true,
    };
  }
}
(globalThis as any).caches = {
  default: {
    match: async () => null,
    put: async () => {},
    delete: async () => true,
  },
};

// Cloudflare's static file serving, near enough: folders serve their index.html, anything missing gets the 404 page.
const ASSETS = {
  fetch: async (req: Request) => {
    const path = new URL(req.url).pathname;
    const name = path.endsWith("/") ? path + "index.html" : path;
    const read = (file: string) =>
      readFileSync(new URL("../../site" + file, import.meta.url));
    try {
      return new Response(read(name), {
        headers: {
          "content-type": TYPES[name.split(".").pop()!] || "text/plain",
        },
      });
    } catch {
      return new Response(read("/404.html"), {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }
  },
} as unknown as Fetcher;

// Email the Worker sends through Resend lands here. Nothing else outside the shop is reachable.
let sent: { to: string[]; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.resend.com/")) {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "x" }));
  }
  return new Response("not reachable in tests", { status: 503 });
}) as typeof fetch;

function makeEnv(): Env {
  return {
    GC_KV: new KV() as unknown as KVNamespace,
    ASSETS,
    DEMO_CATALOG: "true",
    SITE_URL: SITE,
    SHIPPING_FLAT_CENTS: "950",
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "Golem Craftworks <commissions@shop.test>",
    COMMISSION_TO: "shop@shop.test",
  } as Env;
}

async function serve(env: Env, request: Request) {
  const waiting: Promise<unknown>[] = [];
  const res = await worker.fetch(request, env, {
    waitUntil: (p: Promise<unknown>) => void waiting.push(p),
  } as never);
  await Promise.all(waiting);
  return res;
}

const browsers: Browser[] = [];
after(() => Promise.all(browsers.map((b) => b.close())));

// A visitor's browser pointed at the shop. Pages and fetches go to the Worker; the wider internet doesn't exist.
async function visitor(env = makeEnv()) {
  // Scripts in a page load one after another, which happy-dom does without waiting, so they're fetched up front.
  const scripts = new Map<string, Buffer>();
  for (const f of readdirSync(new URL("../../site/js", import.meta.url))) {
    if (!f.endsWith(".js")) continue;
    const res = await serve(env, new Request(`${SITE}/js/${f}`));
    scripts.set(`/js/${f}`, Buffer.from(await res.arrayBuffer()));
  }
  const requests: string[] = [];
  // happy-dom gives every page a clean localStorage. A real browser keeps it, so it's carried over by hand:
  // noted when leaving a page, and put back as the next one fetches its first script.
  const kept: Record<"localStorage" | "sessionStorage", [string, string][]> = {
    localStorage: [],
    sessionStorage: [],
  };
  const restored = new WeakSet<object>();
  const browser = new Browser({
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableCSSFileLoading: true,
      fetch: {
        interceptor: {
          beforeSyncRequest: ({ request, window }: any) => {
            if (!restored.has(window)) {
              restored.add(window);
              for (const store of ["localStorage", "sessionStorage"] as const)
                for (const [k, v] of kept[store]) window[store].setItem(k, v);
            }
            const body = scripts.get(new URL(request.url).pathname);
            return {
              status: body ? 200 : 404,
              statusText: body ? "OK" : "Not Found",
              ok: !!body,
              url: request.url,
              redirected: false,
              headers: new window.Headers({
                "content-type": "text/javascript",
              }),
              body: body ?? Buffer.from(""),
            };
          },
          beforeAsyncRequest: async ({ request, window }: any) => {
            const url = new URL(request.url);
            if (url.origin !== SITE)
              return new window.Response("", { status: 404 });
            requests.push(`${request.method} ${url.pathname}${url.search}`);
            const hasBody = !["GET", "HEAD"].includes(request.method);
            const res = await serve(
              env,
              new Request(request.url, {
                method: request.method,
                headers: [...request.headers],
                body: hasBody ? await request.arrayBuffer() : undefined,
              }),
            );
            return new window.Response(Buffer.from(await res.arrayBuffer()), {
              status: res.status,
              headers: [...res.headers],
            });
          },
        },
      },
    },
  } as any);
  browsers.push(browser);
  const page = browser.newPage();
  const errors: string[] = [];
  page.virtualConsolePrinter.addEventListener("print", () => {
    // Stylesheets are left out (nothing here looks at layout), and happy-dom says so each time.
    const out = page.virtualConsolePrinter
      .readAsString()
      .split("\n")
      .filter((l) => /error/i.test(l) && !l.includes("CSS file loading"));
    errors.push(...out);
  });

  const doc = () => page.mainFrame.document as any;
  const win = () => page.mainFrame.window as any;
  const $ = (sel: string) => doc().querySelector(sel);
  const $$ = (sel: string): any[] => [...doc().querySelectorAll(sel)];
  const text = (sel: string) =>
    ($(sel)?.textContent || "").replace(/\s+/g, " ").trim();
  // Waits for the page to get somewhere: scripts fetch and draw in their own time.
  async function until(what: string, ready: () => unknown) {
    for (let i = 0; i < 200; i++) {
      if (ready()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail(
      `waited for ${what}; the page says: ${text("body").slice(0, 400)}`,
    );
  }
  return {
    env,
    requests,
    errors,
    $,
    $$,
    text,
    until,
    win,
    async go(path: string) {
      for (const store of ["localStorage", "sessionStorage"] as const) {
        const s = win()[store];
        kept[store] = Array.from({ length: s.length }, (_, i) => [
          s.key(i),
          s.getItem(s.key(i)),
        ]);
      }
      await page.goto(SITE + path);
      await until("the header", () => $(".site-header .brand"));
    },
    click(sel: string) {
      const el = $(sel);
      assert.ok(el, `nothing to click at ${sel}`);
      el.click();
    },
    fill(fields: Record<string, string>) {
      for (const [name, value] of Object.entries(fields)) {
        const el = $(`[name="${name}"]`);
        assert.ok(el, `no field named ${name}`);
        el.value = value;
      }
    },
    submit(sel: string) {
      $(sel).dispatchEvent(
        new (win().Event)("submit", { bubbles: true, cancelable: true }),
      );
    },
  };
}

test("home: one tile per category with something available, linked to its page", async () => {
  const v = await visitor();
  await v.go("/");
  await v.until("the category tiles", () => v.$$(".cat").length === 2);
  assert.deepEqual(
    v.$$(".cat__name").map((el) => el.textContent),
    ["8-piece RPG Dice", "Woodworks"],
  );
  assert.deepEqual(
    v.$$(".cat a").map((a) => a.pathname),
    ["/shop/8-piece-rpg-dice", "/shop/woodworks"],
  );
  assert.equal(v.text(".cat__count"), "7 pieces"); // eight dice sets, one of them sold
  assert.equal(v.text("[data-cart-count]"), "0");
  assert.deepEqual(v.errors, []);
});

test("every page gets the header, the footer, and the cart", async () => {
  const v = await visitor();
  for (const path of [
    "/about/",
    "/shipping/",
    "/commissions/",
    "/reviews/",
    "/thanks/",
    "/nowhere",
  ]) {
    await v.go(path);
    assert.deepEqual(
      v.$$(".site-header .nav a").map((a) => a.textContent),
      ["Shop", "Commissions", "Reviews", "About"],
      path,
    );
    assert.match(
      v.text(".site-footer"),
      /Payments are processed securely by Square/,
      path,
    );
    assert.ok(v.$(".drawer"), path);
  }
  await v.go("/shipping/");
  assert.match(v.text("main"), /for a flat \$9\.50\./);
  assert.equal(
    v.$('.nav a[aria-current="page"]'),
    null,
    "shipping isn't in the menu",
  );
  await v.go("/about/");
  assert.equal(v.text('.nav a[aria-current="page"]'), "About");
  assert.deepEqual(v.errors, []);
});

test("category page: available pieces, sold ones on request, links to the others", async () => {
  const v = await visitor();
  await v.go("/shop/8-piece-rpg-dice");
  await v.until("the product cards", () => v.$$(".card").length === 7);
  assert.equal(v.text("h1"), "8-piece RPG Dice");
  assert.equal(v.text('.chip[aria-current="page"]'), "8-piece RPG Dice");
  assert.ok(v.$$(".card a").every((a) => a.pathname.startsWith("/product/")));
  assert.ok(!v.text("[data-grid]").includes("FROST"));

  v.$("[data-show-sold]").checked = true;
  v.$("[data-show-sold]").dispatchEvent(
    new (v.win().Event)("change", { bubbles: true }),
  );
  await v.until("the sold piece", () => v.$$(".card").length === 8);
  assert.equal(v.text(".card--sold .card__price"), "Sold");

  await v.go("/shop/not-a-category");
  await v.until("the not-here message", () =>
    /wandered off|isn't here/.test(v.text("main")),
  );
  assert.deepEqual(v.errors, []);
});

test("product page: a one-of-a-kind piece goes in the cart once", async () => {
  const v = await visitor();
  await v.go("/product/java-ttrpg-dice-set");
  await v.until("the add button", () => v.text("[data-add]") === "Add to cart");
  assert.equal(v.text("h1"), '"JAVA" TTRPG Dice Set');
  assert.equal(v.text("[data-price]"), "$55");
  assert.match(v.text("[data-stock]"), /One of a kind/);
  assert.match(v.text(".product__aside"), /flat \$9\.50/);

  v.click("[data-add]");
  await v.until("the cart count", () => v.text("[data-cart-count]") === "1");
  assert.equal(v.text("[data-add]"), "In your cart · view cart");
  assert.match(v.text("[data-toast]"), /Added "JAVA" TTRPG Dice Set/);

  v.click("[data-add]"); // now it opens the cart
  await v.until("the cart", () => v.$(".drawer.is-open"));
  assert.equal(v.text(".line__name"), '"JAVA" TTRPG Dice Set');
  assert.ok(v.$("[data-remove]"), "one of a kind: remove, not a quantity");
  assert.match(v.text(".fulfil"), /Ship it · \$9\.50/);
  assert.match(v.text(".totals"), /\$64\.50/);

  v.click('[name="fulfil"][value="pickup"]');
  v.$('[name="fulfil"][value="pickup"]').dispatchEvent(
    new (v.win().Event)("change", { bubbles: true }),
  );
  await v.until("the pickup total", () => /\$55$/.test(v.text(".totals")));

  v.click("[data-remove]");
  await v.until("an empty cart", () =>
    /Your cart is empty/.test(v.text(".drawer")),
  );
  assert.equal(v.text("[data-cart-count]"), "0");
  assert.deepEqual(v.errors, []);
});

test("product page: options and add-ons change the price; the cart keeps them", async () => {
  const v = await visitor();
  await v.go("/product/yahtzee-set");
  await v.until("the add button", () => v.text("[data-add]") === "Add to cart");
  assert.equal(v.text("[data-price]"), "$80"); // walnut, with the handmade dice ticked by default
  assert.ok(
    v.$('[name="variation"][value]:disabled'),
    "the sold-out wood can't be picked",
  );

  const pick = (sel: string, checked = true) => {
    v.$(sel).checked = checked;
    v.$(sel).dispatchEvent(new (v.win().Event)("change", { bubbles: true }));
  };
  pick('[name="variation"][value="y-cherry"]');
  await v.until("cherry's price", () => v.text("[data-price]") === "$75");
  pick('[name^="mod-"]', false);
  await v.until(
    "the price without add-ons",
    () => v.text("[data-price]") === "$60",
  );
  assert.equal(v.text("[data-stock]"), "2 left");

  v.click("[data-add]");
  await v.until("the cart count", () => v.text("[data-cart-count]") === "1");
  v.click("[data-open-cart]");
  await v.until("the cart", () => v.$(".drawer.is-open"));
  assert.equal(v.text(".line__variant"), "Cherry");
  v.click("[data-inc]");
  await v.until("two in the cart", () => v.text(".qty output") === "2");
  assert.ok(v.$("[data-inc]").disabled, "only two in stock");
  assert.match(v.text(".totals"), /\$129\.50/);

  // The cart is still there on the next page.
  await v.go("/");
  assert.equal(v.text("[data-cart-count]"), "2");
  assert.deepEqual(v.errors, []);
});

test("product page: a piece that isn't there says so", async () => {
  const v = await visitor();
  await v.go("/product/never-made");
  assert.match(v.text("main"), /wandered off|isn't here/);
});

test("checkout: stock is checked again, and a failure is shown in the cart", async () => {
  const v = await visitor();
  await v.go("/product/hex-dice-vault");
  await v.until("the add button", () => v.text("[data-add]") === "Add to cart");
  v.click("[data-add]");
  await v.until("the cart count", () => v.text("[data-cart-count]") === "1");
  v.click("[data-open-cart]");
  await v.until("the cart", () => v.$("[data-checkout]"));
  v.requests.length = 0;
  v.click("[data-checkout]");
  // The sample catalog has no Square behind it, so the Worker can't make a payment link.
  await v.until("the error", () => v.$(".form-error"));
  assert.ok(v.requests.includes("GET /api/products?fresh=1"));
  assert.ok(v.requests.includes("POST /api/checkout"));
  assert.match(v.text(".form-error"), /Something went wrong on our side/);
});

test("thank-you page: empties the cart", async () => {
  const v = await visitor();
  await v.go("/product/moss-ttrpg-dice-set");
  await v.until("the add button", () => v.text("[data-add]") === "Add to cart");
  v.click("[data-add]");
  await v.until("the cart count", () => v.text("[data-cart-count]") === "1");
  v.requests.length = 0;
  await v.go("/thanks/");
  await v.until("an empty cart", () => v.text("[data-cart-count]") === "0");
  await v.until("a fresh look at the stock", () =>
    v.requests.includes("GET /api/products?fresh=1"),
  );
  assert.deepEqual(v.errors, []);
});

test("commission form: says what's missing, then sends", async () => {
  sent = [];
  const v = await visitor();
  await v.go("/commissions/");
  v.submit("[data-commission]");
  await v.until("what's missing", () => v.text("[data-form-status]"));
  assert.equal(
    v.text("[data-form-status]"),
    "Add your name, a valid email, a description of your idea to send the request.",
  );
  assert.equal(v.$('[name="name"]').getAttribute("aria-invalid"), "true");
  assert.equal(sent.length, 0);

  v.fill({ name: "Jane Doe", email: "not-an-email", idea: "A walnut vault." });
  v.submit("[data-commission]");
  await v.until("the email complaint", () =>
    /^Add a valid email/.test(v.text("[data-form-status]")),
  );
  assert.equal(v.$('[name="name"]').getAttribute("aria-invalid"), null);
  assert.equal(v.$('[name="email"]').getAttribute("aria-invalid"), "true");

  v.fill({ email: "jane@example.com", when: "before December 15" });
  v.submit("[data-commission]");
  await v.until("the confirmation", () =>
    /^Request sent/.test(v.text("[data-form-status]")),
  );
  assert.match(v.text("[data-form-status]"), /on its way to jane@example\.com/);
  assert.deepEqual(
    sent.map((m) => m.to[0]),
    ["shop@shop.test", "jane@example.com"],
  );
  assert.match(sent[0].text, /Needed by: before December 15/);
  assert.equal(v.$('[name="name"]').value, "", "the form is cleared");
  assert.deepEqual(v.errors, []);
});

test("reviews: the list, the summary, and leaving one", async () => {
  sent = [];
  const env = makeEnv();
  await env.GC_KV.put(
    "reviews:site",
    JSON.stringify([
      {
        id: "r1",
        source: "site",
        name: "Sam",
        rating: 4,
        text: "Lovely vault.",
        product: "Hex dice vault",
        photos: [],
        at: "2026-09-15T12:00:00.000Z",
      },
    ]),
  );
  // The same review as the Worker stores it, which the list above is rebuilt from.
  await env.GC_KV.put(
    "review:item:r1",
    JSON.stringify({
      id: "r1",
      key: "k",
      status: "approved",
      name: "Sam",
      rating: 4,
      text: "Lovely vault.",
      product: "Hex dice vault",
      photoTypes: [],
      at: "2026-09-15T12:00:00.000Z",
    }),
  );
  const v = await visitor(env);
  await v.go("/reviews/");
  await v.until("the review", () => v.$$(".review").length === 1);
  assert.match(
    v.text(".review"),
    /Lovely vault\..*Sam · Hex dice vault · September 2026/,
  );
  assert.match(v.text("[data-review-summary]"), /4\.0 from 1 review/);

  v.submit("[data-review-form]");
  await v.until("what's missing", () => v.text("[data-form-status]"));
  assert.equal(
    v.text("[data-form-status]"),
    "Add your name, a valid email, a star rating, a few words about it to send your review.",
  );

  // A form sent within three seconds of opening is taken for a bot, so let some time pass.
  const now = v.win().Date.now;
  v.win().Date.now = () => now() + 10_000;
  v.fill({ name: "Jane", email: "jane@example.com", text: "Love the dice." });
  v.$('[name="rating"][value="5"]').checked = true;
  v.submit("[data-review-form]");
  await v.until("the thank-you", () =>
    /^Thank you/.test(v.text("[data-form-status]")),
  );
  assert.equal(
    v.text("[data-form-status]"),
    "Thank you! Your review is posted.",
  );
  assert.equal(v.$$(".review").length, 2);
  assert.match(v.text(".review"), /Love the dice\..*Jane/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /New review: ★★★★★ from Jane/);

  // The home page quotes the same numbers.
  await v.go("/");
  await v.until("the proof line", () => v.text("[data-proof]"));
  assert.match(v.text("[data-proof]"), /★ 4\.5 from 2 reviews/);
  assert.deepEqual(v.errors, []);
});

test("the color theme switches and is remembered", async () => {
  const v = await visitor();
  await v.go("/about/");
  const theme = () => v.$("html").dataset.theme;
  assert.equal(theme(), "light");
  v.click("[data-theme-toggle]");
  assert.equal(theme(), "dark");
  await v.go("/");
  assert.equal(theme(), "dark");
});
