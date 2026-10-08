// Reviews: Etsy's reviews and the sales count, plus reviews left on the site.
//
//   * Etsy reviews are read with the app key alone (no shop sign-in) and cached in KV.
//   * The sales count is Etsy's all-time figure plus Square sales since SQUARE_SALES_SINCE.
//   * Site reviews show straight away, unless one has a link in it (the mark of spam): that one waits for a look.
//     Each review has its own private link for hiding or deleting it.
//   * The reviewer's email goes to the shop in the notification email and is never stored or logged.

import * as etsyApi from "./etsy.ts";
import * as square from "./square.ts";
import { isEmail, mailReady, send } from "./commission.ts";
import { json, logEvent, errMsg, safeEqual } from "./util.ts";
import { decodeEntities } from "./descriptions.ts";
import type {
  Ctx,
  Env,
  EtsyReviewCache,
  PublicReview,
  SiteReview,
} from "./types.ts";

const CACHE_KEY = "https://cache.golemcraftworks.internal/reviews";
const CACHE_TTL = 60;
const ETSY_MAX_AGE_MS = 6 * 3600 * 1000;
const ETSY_CACHE_VERSION = 3; // raise when the saved shape or cleaning changes, so old copies are refetched
const LIMITS = {
  name: 60,
  text: 2000,
  product: 120,
  photos: 3,
  photoBytes: 1.5 * 1024 * 1024,
  bodyBytes: 6 * 1024 * 1024,
};
const MAX_PER_VISITOR_PER_DAY = 3;
const MAX_PER_DAY = 40;
const MIN_FILL_MS = 3000;
const TURNSTILE_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const itemKey = (id: string) => `review:item:${id}`;
const photoKey = (id: string, i: number) => `review:photo:${id}:${i}`;
const purge = () => caches.default.delete(CACHE_KEY);

// ---------- Etsy ----------

interface EtsyShop {
  transaction_sold_count?: number;
  review_count?: number;
  review_average?: number;
}
interface EtsyReview {
  transaction_id: number;
  rating: number;
  review?: string;
  image_url_fullxfull?: string;
  create_timestamp: number;
}

// Etsy's figure already includes Square sales from when Etsy's own Square integration was connected,
// so Square is only counted from the day that was turned off. If Square can't be reached, keep the last count.
async function squareSales(env: Env) {
  if (!env.SQUARE_SALES_SINCE) return 0;
  try {
    return await square.itemsSoldSince(env, env.SQUARE_SALES_SINCE);
  } catch (e) {
    await logEvent(env, "Square sales count didn't refresh", {
      error: errMsg(e),
    });
    return (
      (await env.GC_KV.get<EtsyReviewCache>("reviews:etsy", "json"))
        ?.squareSales ?? 0
    );
  }
}

export async function refreshEtsyReviews(
  env: Env,
): Promise<EtsyReviewCache | null> {
  if (!etsyApi.etsyKeyReady(env)) return null;
  const shop = await etsyApi.etsyPublic<EtsyShop>(
    env,
    `/shops/${env.ETSY_SHOP_ID}`,
  );
  const all: EtsyReview[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await etsyApi.etsyPublic<{ results?: EtsyReview[] }>(
      env,
      `/shops/${env.ETSY_SHOP_ID}/reviews?limit=100&offset=${offset}`,
    );
    all.push(...(page.results || []));
    if (!page.results || page.results.length < 100) break;
  }
  // Etsy sends review text with characters as HTML codes ("can&#39;t").
  const words = (r: EtsyReview) => decodeEntities(r.review || "").trim();
  const cache: EtsyReviewCache = {
    v: ETSY_CACHE_VERSION,
    at: Date.now(),
    sales: shop.transaction_sold_count ?? null,
    squareSales: await squareSales(env),
    count: shop.review_count ?? all.length,
    average: shop.review_average ?? null,
    // Star-only reviews count toward the average but there's nothing to show for them.
    reviews: all
      .filter((r) => words(r) || r.image_url_fullxfull)
      .map((r) => ({
        id: `etsy-${r.transaction_id}`,
        source: "etsy",
        name: "Etsy buyer",
        rating: r.rating,
        text: words(r),
        product: "",
        photos: r.image_url_fullxfull ? [r.image_url_fullxfull] : [],
        at: new Date(r.create_timestamp * 1000).toISOString(),
      })),
  };
  await env.GC_KV.put("reviews:etsy", JSON.stringify(cache));
  await purge();
  return cache;
}

// Straight after a Square sale: recount now instead of waiting for the hourly refresh.
export async function refreshSquareSales(env: Env) {
  const cached = await env.GC_KV.get<EtsyReviewCache>("reviews:etsy", "json");
  if (!cached || !env.SQUARE_SALES_SINCE) return;
  const squareSales = await square.itemsSoldSince(env, env.SQUARE_SALES_SINCE);
  if (squareSales === cached.squareSales) return;
  await env.GC_KV.put(
    "reviews:etsy",
    JSON.stringify({ ...cached, squareSales }),
  );
  await purge();
}

async function etsyReviews(env: Env, ctx: Ctx) {
  const cached = await env.GC_KV.get<EtsyReviewCache>("reviews:etsy", "json");
  if (!etsyApi.etsyKeyReady(env)) return cached;
  const refresh = () =>
    refreshEtsyReviews(env).catch(async (e) => {
      await logEvent(env, "Etsy reviews didn't refresh", { error: errMsg(e) });
      return null;
    });
  if (!cached || cached.v !== ETSY_CACHE_VERSION)
    return (await refresh()) || cached;
  if (Date.now() - cached.at > ETSY_MAX_AGE_MS) ctx.waitUntil(refresh());
  return cached;
}

// ---------- Public list ----------

export async function list(env: Env, ctx: Ctx) {
  const hit = await caches.default.match(CACHE_KEY);
  if (hit) return hit;
  const [etsy, site] = await Promise.all([
    etsyReviews(env, ctx),
    env.GC_KV.get<PublicReview[]>("reviews:site", "json"),
  ]);
  const mine = site || [];
  const reviews = [...mine, ...(etsy?.reviews || [])].sort((a, b) =>
    b.at.localeCompare(a.at),
  );

  const etsyCount = etsy?.count || 0;
  const count = etsyCount + mine.length;
  const stars =
    (etsy?.average || 0) * etsyCount + mine.reduce((n, r) => n + r.rating, 0);
  const sales =
    etsy && etsy.sales !== null ? etsy.sales + (etsy.squareSales || 0) : null;
  const res = json(
    {
      reviews,
      stats: {
        count,
        average: count ? Math.round((stars / count) * 10) / 10 : null,
        sales,
      },
    },
    200,
    { "cache-control": `public, max-age=${CACHE_TTL}` },
  );
  ctx.waitUntil(caches.default.put(CACHE_KEY, res.clone()));
  return res;
}

// ---------- Submitting ----------

// Trust the bytes, not the filename or the type the browser claims.
function imageType(bytes: Uint8Array) {
  const at = (i: number, ...sig: number[]) =>
    sig.every((b, j) => bytes[i + j] === b);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  return null;
}

async function overLimit(env: Env, request: Request) {
  const day = Math.floor(Date.now() / 86400000);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const keys = [
    [`review:rate:${ip}:${day}`, MAX_PER_VISITOR_PER_DAY],
    [`review:rate:all:${day}`, MAX_PER_DAY],
  ] as const;
  const counts = await Promise.all(
    keys.map(async ([k]) => Number(await env.GC_KV.get(k)) || 0),
  );
  if (counts.some((n, i) => n >= keys[i][1])) return true;
  await Promise.all(
    keys.map(([k], i) =>
      env.GC_KV.put(k, String(counts[i] + 1), { expirationTtl: 2 * 86400 }),
    ),
  );
  return false;
}

// Real reviews almost never carry a web address; spam nearly always does.
const LINK = /https?:|www\.|\.(com|net|org|ru|info|biz|xyz|top|shop)\b/i;

async function passesTurnstile(env: Env, request: Request, token: string) {
  if (!env.TURNSTILE_SECRET) return true; // not set up yet: the other checks still apply
  if (!token) return false;
  const res = await fetch(TURNSTILE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get("cf-connecting-ip") || "",
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return data.success === true;
}

export async function submit(request: Request, env: Env) {
  if (Number(request.headers.get("content-length")) > LIMITS.bodyBytes)
    return json(
      { error: "Those photos are too large. Try fewer or smaller ones." },
      413,
    );
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const field = (name: string, max: number) => {
    const v = form.get(name);
    return typeof v === "string" ? v.trim().slice(0, max) : "";
  };

  // A hidden field real visitors never fill in, and a form sent faster than anyone can type.
  // Pretend it worked so bots don't retry.
  if (field("website", 10) || Number(field("elapsed", 12)) < MIN_FILL_MS)
    return json({ ok: true });

  const name = field("name", LIMITS.name).replace(/\s+/g, " ");
  const email = field("email", 254);
  const text = field("text", LIMITS.text);
  const rating = Number(field("rating", 1));
  const missing: string[] = [];
  if (!name) missing.push("your name");
  if (!isEmail(email)) missing.push("a valid email");
  if (!(Number.isInteger(rating) && rating >= 1 && rating <= 5))
    missing.push("a star rating");
  if (!text) missing.push("a few words about it");
  if (missing.length)
    return json(
      { error: `Add ${missing.join(", ")} to send your review.`, missing },
      400,
    );

  const files = form
    .getAll("photos")
    .filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (files.length > LIMITS.photos)
    return json({ error: `Add up to ${LIMITS.photos} photos.` }, 400);
  const photos: { type: string; bytes: ArrayBuffer }[] = [];
  for (const f of files) {
    if (f.size > LIMITS.photoBytes)
      return json({ error: "One of those photos is too large." }, 413);
    const bytes = await f.arrayBuffer();
    const type = imageType(new Uint8Array(bytes.slice(0, 12)));
    if (!type)
      return json(
        { error: "Photos need to be JPEG, PNG, or WebP images." },
        400,
      );
    photos.push({ type, bytes });
  }

  if (
    !(await passesTurnstile(env, request, field("cf-turnstile-response", 4000)))
  ) {
    return json(
      { error: "The spam check didn't pass. Reload the page and try again." },
      403,
    );
  }
  if (await overLimit(env, request))
    return json(
      { error: "That's a lot of reviews in one day. Try again tomorrow." },
      429,
    );

  const review: SiteReview = {
    id: crypto.randomUUID(),
    key: crypto.randomUUID().replace(/-/g, ""),
    status: "approved",
    name,
    rating,
    text,
    product: field("product", LIMITS.product),
    photoTypes: photos.map((p) => p.type),
    at: new Date().toISOString(),
  };
  await Promise.all(
    photos.map((p, i) => env.GC_KV.put(photoKey(review.id, i), p.bytes)),
  );
  const held = LINK.test(`${name} ${text} ${review.product}`);
  if (held) review.status = "pending";
  await env.GC_KV.put(itemKey(review.id), JSON.stringify(review));
  if (!held) await rebuildIndex(env);

  // The email address leaves here and only here.
  let notified = false;
  if (mailReady(env)) {
    try {
      await send(env, {
        from: env.EMAIL_FROM,
        to: [env.COMMISSION_TO],
        reply_to: email,
        subject: `New review${held ? " to check" : ""}: ${"★".repeat(rating)} from ${name}`,
        text:
          `${name} <${email}> left a ${rating}-star review${review.product ? ` of ${review.product}` : ""}` +
          `${photos.length ? ` with ${photos.length} photo${photos.length > 1 ? "s" : ""}` : ""}.\n\n${text}\n\n` +
          (held
            ? `It has a link in it, so it's hidden until you show it:`
            : `It's showing on the site now. To hide or delete it:`) +
          `\n${moderationUrl(env, request, review)}\n\n--\n` +
          `Reply to this email to write to ${name} directly. Their address isn't stored anywhere else.`,
      });
      notified = true;
    } catch (e) {
      await logEvent(env, "Review notification email failed", {
        id: review.id,
        error: errMsg(e),
      });
    }
  }
  if (!notified)
    await logEvent(
      env,
      `New review ${held ? "is waiting" : "was posted (see it)"} at /admin/reviews (no notification email was sent)`,
      { id: review.id },
    );
  return json(held ? { ok: true } : { ok: true, review: toPublic(review) });
}

function moderationUrl(env: Env, request: Request, r: SiteReview) {
  const base = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, "");
  return `${base}/admin/review?id=${r.id}&key=${r.key}`;
}

// ---------- Photos ----------

export async function photo(env: Env, url: URL) {
  const m = url.pathname.match(
    /^\/api\/reviews\/photo\/([0-9a-f-]{36})\/(\d)$/,
  );
  const review = m && (await env.GC_KV.get<SiteReview>(itemKey(m[1]), "json"));
  const i = m ? Number(m[2]) : 0;
  const approved = review?.status === "approved";
  if (
    !m ||
    !review ||
    i >= review.photoTypes.length ||
    !(approved || safeEqual(url.searchParams.get("key"), review.key))
  ) {
    return json({ error: "Not found" }, 404);
  }
  const bytes = await env.GC_KV.get(photoKey(review.id, i), "arrayBuffer");
  if (!bytes) return json({ error: "Not found" }, 404);
  return new Response(bytes, {
    headers: {
      "content-type": review.photoTypes[i],
      "x-content-type-options": "nosniff",
      "cache-control": approved
        ? "public, max-age=31536000, immutable"
        : "private, no-store",
    },
  });
}

// ---------- Hiding and deleting ----------

async function allSiteReviews(env: Env) {
  const out: SiteReview[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.GC_KV.list({ prefix: "review:item:", cursor });
    for (const k of page.keys) {
      const r = await env.GC_KV.get<SiteReview>(k.name, "json");
      if (r) out.push(r);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function toPublic(r: SiteReview): PublicReview {
  return {
    id: r.id,
    source: "site",
    name: r.name,
    rating: r.rating,
    text: r.text,
    product: r.product,
    photos: r.photoTypes.map((_, i) => `/api/reviews/photo/${r.id}/${i}`),
    at: r.at,
  };
}

// The reviews that are showing, in the shape the site shows, kept under one key so the page needs one read.
async function rebuildIndex(env: Env) {
  const index = (await allSiteReviews(env))
    .filter((r) => r.status === "approved")
    .map(toPublic);
  await env.GC_KV.put("reviews:site", JSON.stringify(index));
  await purge();
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string, status = 200) =>
  new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Reviews · Golem Craftworks</title>` +
      `<body style="font:17px/1.5 system-ui;padding:32px;max-width:60ch;margin:auto">${body}</body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

function card(r: SiteReview) {
  return (
    `<p><strong>${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</strong> ${esc(r.name)}${r.product ? ` · ${esc(r.product)}` : ""}` +
    ` · ${esc(r.at.slice(0, 10))} · <em>${r.status === "approved" ? "showing" : "hidden"}</em></p><p style="white-space:pre-line">${esc(r.text)}</p>` +
    r.photoTypes
      .map(
        (_, i) =>
          `<img src="/api/reviews/photo/${r.id}/${i}?key=${r.key}" alt="" style="max-width:100%;margin:0 0 12px;display:block">`,
      )
      .join("")
  );
}

// /admin/reviews?token=...   every review, newest first
// /admin/review?id=&key=     one review with Show / Hide / Delete buttons (the link in the notification email)
export async function moderate(request: Request, env: Env, url: URL) {
  if (url.pathname === "/admin/reviews") {
    if (
      !(
        env.ADMIN_TOKEN &&
        safeEqual(url.searchParams.get("token") || "", env.ADMIN_TOKEN)
      )
    )
      return json({ error: "Not found" }, 404);
    const all = await allSiteReviews(env);
    const rank = (r: SiteReview) => (r.status === "pending" ? 0 : 1);
    return page(
      `<h1>Reviews left on the site</h1>` +
        (all.length
          ? all
              .sort((a, b) => rank(a) - rank(b))
              .map(
                (r) =>
                  `<hr>${card(r)}<p><a href="/admin/review?id=${r.id}&key=${r.key}">Open</a></p>`,
              )
              .join("")
          : "<p>None yet.</p>"),
    );
  }

  // Changes only happen on a button press, so a mail scanner opening the link can't change anything.
  const params =
    request.method === "POST"
      ? new URLSearchParams(await request.text())
      : url.searchParams;
  const id = params.get("id") || "";
  const review = /^[0-9a-f-]{36}$/.test(id)
    ? await env.GC_KV.get<SiteReview>(itemKey(id), "json")
    : null;
  if (!review || !safeEqual(params.get("key"), review.key))
    return page(
      "<p>That review isn't here. It may have been deleted.</p>",
      404,
    );

  if (request.method === "POST") {
    const action = params.get("action");
    if (action === "delete") {
      await Promise.all([
        env.GC_KV.delete(itemKey(id)),
        ...review.photoTypes.map((_, i) => env.GC_KV.delete(photoKey(id, i))),
      ]);
      await rebuildIndex(env);
      return page("<p>Deleted.</p>");
    }
    if (action === "approve" || action === "hide") {
      review.status = action === "approve" ? "approved" : "pending";
      await env.GC_KV.put(itemKey(id), JSON.stringify(review));
      await rebuildIndex(env);
    }
  }
  const button = (action: string, label: string) =>
    `<form method="post" action="/admin/review" style="display:inline"><input type="hidden" name="id" value="${review.id}">` +
    `<input type="hidden" name="key" value="${review.key}"><button name="action" value="${action}" style="font:inherit;padding:8px 16px;margin-right:8px">${label}</button></form>`;
  return page(
    `<h1>Review from ${esc(review.name)}</h1>${card(review)}<p>` +
      (review.status === "approved"
        ? button("hide", "Hide from the site")
        : button("approve", "Show on the site")) +
      button("delete", "Delete") +
      `</p>`,
  );
}
