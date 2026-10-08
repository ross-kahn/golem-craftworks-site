// Pages and files the Worker builds from the catalog so search engines and AI crawlers, which mostly
// don't run page scripts, get the real content:
//
//   /product/<slug>     the product page, complete: name, price, photos, description, product data
//   /shop/<slug>        a category page with its product grid filled in
//   /                   the home page with one tile per category
//   /sitemap.xml  /robots.txt  /llms.txt  /feeds/google.xml
//
// The pages start from the static files in site/ and fill the <!--ssr:…--> slots. The browser scripts
// then take over as before.

import type { Env, PublicProduct, StorefrontCatalog } from "./types.ts";
import { group } from "radashi";
import { isTrue, siteUrl } from "./util.ts";
import { esc, slugify } from "../../shared/text.ts";
import { OTHER, byCategory, tilePhotos } from "../../shared/catalog.ts";

// KV: every address a product has been served at -> its Square id (kept up to date in index.ts).
export const ADDRESSES_KEY = "product:addresses";

const SHOP = "Golem Craftworks";
const TAGLINE =
  "Hardwood dice vaults, game sets, and one-of-a-kind dice, made by hand in Madison, Wisconsin.";
// Crawlers behind AI search and assistants, named so the welcome is explicit.
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
];

const money = (cents: number) =>
  `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const noindex = (env: Env) => isTrue(env.NOINDEX);
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
};

const inStock = (p: PublicProduct) =>
  p.variations.some((v) => v.qty === null || v.qty > 0);
const madeToOrder = (p: PublicProduct) =>
  p.variations.every((v) => v.qty === null);
const prices = (p: PublicProduct) => p.variations.map((v) => v.priceCents);
const priceLabel = (p: PublicProduct) => {
  const lo = Math.min(...prices(p)),
    hi = Math.max(...prices(p));
  return lo === hi ? money(lo) : `From ${money(lo)}`;
};

// Categories as the shop shows them: each has its own page at /shop/<slug>, in A-to-Z order with
// "Other" (anything without a Square category) last. The order is in shared/catalog.ts, which the site uses too.
const categoryOf = (p: PublicProduct) => p.category || OTHER;

interface Category {
  name: string;
  slug: string;
  products: PublicProduct[];
}

function categories(catalog: StorefrontCatalog): Category[] {
  const bySlug = group(catalog.products, (p) => slugify(categoryOf(p)));
  return Object.entries(bySlug)
    .map(([slug, products = []]) => ({
      name: categoryOf(products[0]),
      slug,
      products,
    }))
    .sort((a, b) => byCategory(a.name, b.name));
}

function page(html: string, env: Env, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache", // browsers ask each time, so sold pieces don't linger
      ...(noindex(env) ? { "x-robots-tag": "noindex" } : {}),
    },
  });
}

const file = (body: string, type: string) =>
  new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "cache-control": "public, max-age=300",
    },
  });

async function template(env: Env, url: URL, path: string) {
  const res = await env.ASSETS!.fetch(new Request(new URL(path, url)));
  return res.ok ? res.text() : null;
}

// Put `content` in the <!--ssr:name--> slot. The function form keeps "$" in the content literal.
const fill = (html: string, name: string, content: string) =>
  html.replace(
    new RegExp(`<!--ssr:${name}-->[\\s\\S]*?<!--/ssr:${name}-->`),
    () => content,
  );

// Product data in the form search engines read (schema.org).
function productData(p: PublicProduct, link: string, env: Env) {
  const availability = madeToOrder(p)
    ? "MadeToOrder"
    : inStock(p)
      ? "InStock"
      : "OutOfStock";
  const shipping = shippingCents(env);
  const common = {
    priceCurrency: "USD",
    availability: `https://schema.org/${availability}`,
    itemCondition: "https://schema.org/NewCondition",
    url: link,
    seller: { "@type": "Organization", name: SHOP },
    ...(shipping > 0
      ? {
          shippingDetails: {
            "@type": "OfferShippingDetails",
            shippingRate: {
              "@type": "MonetaryAmount",
              value: (shipping / 100).toFixed(2),
              currency: "USD",
            },
            shippingDestination: {
              "@type": "DefinedRegion",
              addressCountry: "US",
            },
          },
        }
      : {}),
  };
  const lo = Math.min(...prices(p)),
    hi = Math.max(...prices(p));
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: p.description,
    image: p.images,
    category: p.category || undefined,
    brand: { "@type": "Brand", name: SHOP },
    offers:
      lo === hi
        ? { "@type": "Offer", price: (lo / 100).toFixed(2), ...common }
        : {
            "@type": "AggregateOffer",
            lowPrice: (lo / 100).toFixed(2),
            highPrice: (hi / 100).toFixed(2),
            offerCount: p.variations.length,
            ...common,
          },
  };
}

// The same structure product.ts draws, without the controls. It's replaced as soon as the script runs.
function productBody(p: PublicProduct) {
  const stock = madeToOrder(p)
    ? "Made to order"
    : inStock(p)
      ? "In stock"
      : "Sold";
  return `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Shop</a> / <a href="/shop/${slugify(categoryOf(p))}">${esc(categoryOf(p))}</a></nav>
      <div class="product">
        <div class="gallery">
          <div class="gallery__main">${p.images.length ? `<img src="${esc(p.images[0])}" alt="${esc(p.name)}" data-main>` : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`}</div>
          ${
            p.images.length > 1
              ? `<div class="gallery__thumbs">${p.images
                  .map(
                    (src, i) =>
                      `<button type="button" aria-label="Photo ${i + 1} of ${p.images.length}"><img src="${esc(src)}" alt="" loading="lazy"></button>`,
                  )
                  .join("")}</div>`
              : ""
          }
        </div>
        <div class="product__info">
          <h1>${esc(p.name)}</h1>
          <p class="product__price">${priceLabel(p)}</p>
          <p class="product__stock">${stock}</p>
          ${p.variations.length > 1 ? `<p>${p.variations.map((v) => esc(v.name)).join(", ")}</p>` : ""}
          <div class="product__desc">${p.description
            .split(/\n{2,}/)
            .map((para) => `<p>${esc(para)}</p>`)
            .join("")}</div>
        </div>
      </div>
    `;
}

export async function productPage(
  env: Env,
  url: URL,
  catalog: StorefrontCatalog,
) {
  const slug = decodeURIComponent(url.pathname.replace(/^\/product\//, ""));
  // One address per product: the one without a slash on the end.
  if (slug.endsWith("/"))
    return Response.redirect(
      new URL(`/product/${slug.replace(/\/+$/, "")}`, url).toString(),
      301,
    );
  const p = catalog.products.find((x) => x.slug === slug);
  if (!p) {
    // An address this product used to have (it was renamed in Square): send visitors to the current one.
    const id = (
      await env.GC_KV.get<Record<string, string>>(ADDRESSES_KEY, "json")
    )?.[slug];
    const moved = id && catalog.products.find((x) => x.id === id);
    if (moved)
      return Response.redirect(
        new URL(`/product/${moved.slug}`, url).toString(),
        301,
      );
  }
  const html = p && (await template(env, url, "/product/"));
  if (!p || !html) return missingPage(env, url);

  const link = `${siteUrl(env, url)}/product/${p.slug}`;
  const title = `${p.name} · ${SHOP}`;
  const description = oneLine(p.description, 160) || TAGLINE;
  const image = p.images[0] || `${siteUrl(env, url)}/assets/logo.png`;
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(link)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="${SHOP}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(link)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<script type="application/ld+json">${JSON.stringify(productData(p, link, env)).replace(/</g, "\\u003c")}</script>`,
  ].join("\n  ");
  return page(fill(fill(html, "head", head), "product", productBody(p)), env);
}

// Sold pieces stay reachable by their own address and the sitemap; the grids open on what's available.
const cards = (products: PublicProduct[]) =>
  products
    .filter(inStock)
    .map(
      (p) => `
          <li class="card"><a href="/product/${esc(p.slug)}">
            <div class="card__media">${p.images[0] ? `<img src="${esc(p.images[0])}" alt="" loading="lazy" decoding="async">` : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`}</div>
            <h3 class="card__name">${esc(p.name)}</h3>
            <div class="card__meta"><span class="card__price">${priceLabel(p)}</span></div>
          </a></li>`,
    )
    .join("");

async function missingPage(env: Env, url: URL) {
  const missing = await template(env, url, "/404.html");
  return missing
    ? page(missing, env, 404)
    : new Response("Not found", { status: 404 });
}

export async function homePage(env: Env, url: URL, catalog: StorefrontCatalog) {
  const all = categories(catalog);
  const html = await template(env, url, "/");
  if (!html) return null;
  // One tile per category with something available, showing its newest few photos.
  const tiles = all
    .map((c) => ({ ...c, products: c.products.filter(inStock) }))
    .filter((c) => c.products.length)
    .map((c) => {
      const photos = tilePhotos(c.products.map((p) => p.images));
      const n = c.products.length;
      return `
          <li class="cat"><a href="/shop/${c.slug}">
            <div class="cat__media" data-n="${photos.length}">${
              photos.length
                ? photos
                    .map(
                      (src) =>
                        `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`,
                    )
                    .join("")
                : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`
            }</div>
            <h3 class="cat__name">${esc(c.name)}</h3>
            <p class="cat__count">${n} ${n === 1 ? "piece" : "pieces"}</p>
          </a></li>`;
    })
    .join("");
  return page(fill(html, "grid", tiles), env);
}

export async function categoryPage(
  env: Env,
  url: URL,
  catalog: StorefrontCatalog,
) {
  const slug = decodeURIComponent(url.pathname.replace(/^\/shop\//, ""));
  // One address per category: the one without a slash on the end.
  if (slug.endsWith("/"))
    return Response.redirect(
      new URL(`/shop/${slug.replace(/\/+$/, "")}`, url).toString(),
      301,
    );
  const all = categories(catalog);
  const c = all.find((x) => x.slug === slug);
  const html = c && (await template(env, url, "/shop/"));
  if (!c || !html) return missingPage(env, url);

  const link = `${siteUrl(env, url)}/shop/${c.slug}`;
  const title = `${c.name} · ${SHOP}`;
  const available = c.products.filter(inStock);
  const n = available.length;
  const description = n
    ? `${c.name}: ${n} handmade ${n === 1 ? "piece" : "pieces"} available now from ${SHOP} in Madison, Wisconsin.`
    : `${c.name}, made by hand at ${SHOP} in Madison, Wisconsin.`;
  const image =
    available.map((p) => p.images[0]).find(Boolean) ||
    `${siteUrl(env, url)}/assets/logo.png`;
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(link)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${SHOP}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(link)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n  ");
  const filters = all
    .map(
      (x) =>
        `<a class="chip" href="/shop/${x.slug}"${x === c ? ' aria-current="page"' : ""}>${esc(x.name)}</a>`,
    )
    .join("");
  const slots = {
    head,
    title: esc(c.name),
    crumb: esc(c.name),
    filters,
    grid: cards(available),
  };
  return page(
    Object.entries(slots).reduce(
      (out, [name, content]) => fill(out, name, content),
      html,
    ),
    env,
  );
}

// ---------- The shipping price, from SHIPPING_FLAT_CENTS ----------

const shippingCents = (env: Env) => Number(env.SHIPPING_FLAT_CENTS || 0);

// The site's settings file with the real shipping price laid over the one written in it.
export async function siteConfig(env: Env, url: URL) {
  const js = await template(env, url, "/js/config.js");
  if (js === null) return null;
  return new Response(
    `${js}\nwindow.GC_CONFIG.shippingCents = ${shippingCents(env)};\n`,
    {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    },
  );
}

export async function shippingPage(env: Env, url: URL) {
  const html = await template(env, url, "/shipping/");
  return html === null
    ? null
    : page(fill(html, "shipping-price", money(shippingCents(env))), env);
}

// ---------- Files for crawlers ----------

const STATIC_PAGES = [
  "/",
  "/commissions/",
  "/reviews/",
  "/about/",
  "/shipping/",
];

export function sitemap(env: Env, url: URL, catalog: StorefrontCatalog) {
  const base = siteUrl(env, url);
  const entry = (path: string, lastmod?: string) =>
    `  <url><loc>${esc(base + path)}</loc>${lastmod ? `<lastmod>${esc(lastmod.slice(0, 10))}</lastmod>` : ""}</url>`;
  return file(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      [
        ...STATIC_PAGES.map((p) => entry(p)),
        ...categories(catalog)
          .filter((c) => c.products.some(inStock))
          .map((c) => entry(`/shop/${c.slug}`)),
        ...catalog.products.map((p) =>
          entry(`/product/${p.slug}`, p.updatedAt),
        ),
      ].join("\n") +
      `\n</urlset>\n`,
    "application/xml",
  );
}

export function robots(env: Env, url: URL) {
  // Before launch the preview address stays out of search results entirely.
  if (noindex(env)) return file("User-agent: *\nDisallow: /\n", "text/plain");
  const rules =
    "Allow: /\nDisallow: /admin/\nDisallow: /api/\nDisallow: /thanks/\n";
  return file(
    `User-agent: *\n${rules}\n` +
      AI_CRAWLERS.map((bot) => `User-agent: ${bot}\n${rules}`).join("\n") +
      `\nSitemap: ${siteUrl(env, url)}/sitemap.xml\n`,
    "text/plain",
  );
}

// A plain-text guide to the shop for AI assistants (the llms.txt convention).
export function llms(env: Env, url: URL, catalog: StorefrontCatalog) {
  const base = siteUrl(env, url);
  const line = (p: PublicProduct) =>
    `- [${p.name}](${base}/product/${p.slug}): ${priceLabel(p)}, ${madeToOrder(p) ? "made to order" : inStock(p) ? "in stock" : "sold"}. ${oneLine(p.description, 140)}`;
  const all = categories(catalog);
  return file(
    [
      `# ${SHOP}`,
      "",
      `> ${TAGLINE} Everything is designed and made by one person, Ross. Orders ship within the US for a flat ${money(shippingCents(env))} or can be picked up in Madison for free. Custom commissions are welcome.`,
      "",
      "## Pages",
      "",
      `- [Shop](${base}/): everything currently available, by category`,
      ...all.map((c) => `- [${c.name}](${base}/shop/${c.slug})`),
      `- [Commissions](${base}/commissions/): how custom orders work, and the request form`,
      `- [Reviews](${base}/reviews/): reviews from Etsy buyers and from this site`,
      `- [About](${base}/about/): who makes the pieces and how`,
      `- [Shipping and returns](${base}/shipping/)`,
      "",
      ...all.flatMap((c) => [`## ${c.name}`, "", ...c.products.map(line), ""]),
    ].join("\n"),
    "text/markdown",
  );
}

// Product feed for Google Merchant Center (free Shopping listings). One entry per thing a buyer can choose.
export function googleFeed(env: Env, url: URL, catalog: StorefrontCatalog) {
  const base = siteUrl(env, url);
  const tag = (name: string, value: string) =>
    `<${name}>${esc(value)}</${name}>`;
  const items = catalog.products
    .filter((p) => p.images.length)
    .flatMap((p) =>
      p.variations.map((v) => {
        const several = p.variations.length > 1;
        return (
          "    <item>\n" +
          [
            tag("g:id", v.id),
            tag(
              "g:title",
              oneLine(several ? `${p.name}, ${v.name}` : p.name, 150),
            ),
            tag("g:description", oneLine(p.description || p.name, 5000)),
            tag("g:link", `${base}/product/${p.slug}`),
            tag("g:image_link", p.images[0]),
            ...p.images
              .slice(1, 11)
              .map((src) => tag("g:additional_image_link", src)),
            tag("g:price", `${(v.priceCents / 100).toFixed(2)} USD`),
            tag(
              "g:availability",
              v.qty === null || v.qty > 0 ? "in_stock" : "out_of_stock",
            ),
            tag("g:condition", "new"),
            tag("g:brand", SHOP),
            tag("g:identifier_exists", "no"), // handmade: no barcode or manufacturer part number
            ...(several ? [tag("g:item_group_id", p.id)] : []),
            ...(p.category ? [tag("g:product_type", p.category)] : []),
          ]
            .map((l) => "      " + l)
            .join("\n") +
          "\n    </item>"
        );
      }),
    );
  return file(
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n` +
      `    ${tag("title", SHOP)}\n    ${tag("link", base)}\n    ${tag("description", TAGLINE)}\n` +
      items.join("\n") +
      `\n  </channel>\n</rss>\n`,
    "application/xml",
  );
}
