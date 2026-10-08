// Talks to the Worker: products, checkout, reviews, and the commission form.
import { OTHER } from "../../shared/catalog.ts";
import { slugify } from "../../shared/text.ts";

const cfg = window.GC_CONFIG;
const CACHE_KEY = "gc-products-v3";
const CACHE_MS = 60 * 1000;

const postJSON = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* non-JSON */
  }
  if (!res.ok) {
    const err: ApiError = new Error(
      (body && body.error) || `Request failed (${res.status})`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getProducts({ fresh = false } = {}): Promise<Product[]> {
  // For two minutes after a purchase (the thank-you page notes the time), skip every saved copy.
  // Square can take a moment to lower the stock, so the first look after paying may still show the piece.
  try {
    if (
      Date.now() - Number(sessionStorage.getItem("gc-bought")) <
      2 * 60 * 1000
    )
      fresh = true;
  } catch (_) {
    /* storage unavailable */
  }
  if (!fresh) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
    } catch (_) {
      /* storage unavailable */
    }
  }
  const data = await fetchJSON<{ products?: RawProduct[] }>(
    "/api/products" + (fresh ? "?fresh=1" : ""),
    fresh ? { cache: "no-store" } : undefined,
  );
  const products = (data.products || []).map(normalize);
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ t: Date.now(), data: products }),
    );
  } catch (_) {}
  return products;
}

function normalize(p: RawProduct): Product {
  const variations = (p.variations || []).map((v) => ({
    ...v,
    // qty null means Square isn't tracking stock for it: treat as available.
    available: v.qty === null || v.qty === undefined ? 99 : Math.max(0, v.qty),
  }));
  const totalAvailable = variations.reduce((n, v) => n + v.available, 0);
  const prices = variations
    .map((v) => v.priceCents)
    .filter((n) => typeof n === "number");
  const modifierLists = p.modifierLists || [];
  // Add-ons move the price range: the cheapest required picks, and every paid extra allowed.
  let minExtra = 0,
    maxExtra = 0;
  modifierLists.forEach((l) => {
    const byPrice = l.modifiers.map((m) => m.priceCents).sort((a, b) => a - b);
    minExtra += byPrice.slice(0, l.min).reduce((n, c) => n + c, 0);
    maxExtra += byPrice.slice(-l.max).reduce((n, c) => n + Math.max(0, c), 0);
  });
  return {
    ...p,
    category: p.category || OTHER,
    variations,
    modifierLists,
    soldOut: totalAvailable === 0,
    // One-of-a-kind: a single variation with exactly one in stock, or flagged in Square.
    unique:
      p.unique === true || (variations.length === 1 && variations[0].qty === 1),
    minPrice: prices.length ? Math.min(...prices) + minExtra : null,
    maxPrice: prices.length ? Math.max(...prices) + maxExtra : null,
  };
}

// By its address (`java-ttrpg-dice-set`, what a product page has to go on) or its Square id.
export async function getProduct(id: string): Promise<Product | null> {
  const all = await getProducts();
  return all.find((p) => p.id === id || p.slug === id) || null;
}

// The addresses the Worker serves each category and product at.
export const categoryLink = (name: string) => `/shop/${slugify(name)}`;
export const productLink = (p: Product) =>
  `/product/${encodeURIComponent(p.slug)}`;

export function createCheckout({
  lines,
  fulfillment,
}: {
  lines: CartLine[];
  fulfillment: Fulfillment;
}) {
  return fetchJSON<{ url?: string }>(
    "/api/checkout",
    postJSON({
      lines: lines.map((l) => ({
        variationId: l.variationId,
        qty: l.qty,
        modifiers: l.modifiers.map((m) => m.id),
      })),
      fulfillment,
    }),
  );
}

export const sendCommission = (data: Record<string, string>) =>
  fetchJSON<{ ok: boolean; confirmationSent: boolean }>(
    "/api/commission",
    postJSON(data),
  );

export async function getReviews(): Promise<ReviewData> {
  const data = await fetchJSON<Partial<ReviewData>>("/api/reviews");
  return {
    reviews: data.reviews || [],
    stats: data.stats || { count: 0, average: null, sales: null },
  };
}

// Sent as a form rather than JSON because it can carry photos.
export const sendReview = (data: FormData) =>
  fetchJSON<{ ok: boolean; review?: Review }>("/api/reviews", {
    method: "POST",
    body: data,
  });

export function money(cents: number | null | undefined): string {
  if (typeof cents !== "number") return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cfg.currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function priceLabel(p: Product): string {
  if (p.minPrice === null) return "";
  return p.minPrice === p.maxPrice
    ? money(p.minPrice)
    : `From ${money(p.minPrice)}`;
}
