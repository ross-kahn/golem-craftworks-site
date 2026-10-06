// Talks to the Cloudflare Worker (or demo data when no Worker is configured).
(function () {
  const cfg = window.GC_CONFIG;
  const CACHE_KEY = "gc-products-v2";
  const CACHE_MS = 60 * 1000;

  const isDemo = () => !cfg.apiBase;

  function siteRoot(): string {
    // Works whether the site is served from the domain root or a subfolder (e.g. a preview).
    const s = document.querySelector<HTMLScriptElement>('script[src$="js/api.js"]');
    return s ? s.src.replace(/js\/api\.js.*$/, "") : "/";
  }

  async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(url, opts);
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const err: ApiError = new Error((body && body.error) || `Request failed (${res.status})`);
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }

  async function getProducts({ fresh = false } = {}): Promise<Product[]> {
    if (!fresh) {
      try {
        const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
        if (hit && Date.now() - hit.t < CACHE_MS) return hit.data;
      } catch (_) { /* storage unavailable */ }
    }
    const url = isDemo()
      ? siteRoot() + "data/demo-products.json"
      : cfg.apiBase.replace(/\/$/, "") + "/api/products";
    const data = await fetchJSON<{ products?: RawProduct[] }>(url);
    const products = (data.products || []).map(normalize);
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data: products })); } catch (_) {}
    return products;
  }

  function normalize(p: RawProduct): Product {
    const variations = (p.variations || []).map((v) => ({
      ...v,
      // qty null means Square isn't tracking stock for it: treat as available.
      available: v.qty === null || v.qty === undefined ? 99 : Math.max(0, v.qty)
    }));
    const totalAvailable = variations.reduce((n, v) => n + v.available, 0);
    const prices = variations.map((v) => v.priceCents).filter((n) => typeof n === "number");
    const modifierLists = p.modifierLists || [];
    // Add-ons move the price range: the cheapest required picks, and every paid extra allowed.
    let minExtra = 0, maxExtra = 0;
    modifierLists.forEach((l) => {
      const byPrice = l.modifiers.map((m) => m.priceCents).sort((a, b) => a - b);
      minExtra += byPrice.slice(0, l.min).reduce((n, c) => n + c, 0);
      maxExtra += byPrice.slice(-l.max).reduce((n, c) => n + Math.max(0, c), 0);
    });
    return {
      ...p,
      variations,
      modifierLists,
      soldOut: totalAvailable === 0,
      // One-of-a-kind: a single variation with exactly one in stock, or flagged in Square.
      unique: p.unique === true || (variations.length === 1 && variations[0].qty === 1),
      minPrice: prices.length ? Math.min(...prices) + minExtra : null,
      maxPrice: prices.length ? Math.max(...prices) + maxExtra : null
    };
  }

  async function getProduct(id: string): Promise<Product | null> {
    const all = await getProducts();
    return all.find((p) => p.id === id || p.slug === id) || null;
  }

  async function createCheckout({ lines, fulfillment }: { lines: CartLine[]; fulfillment: Fulfillment }) {
    if (isDemo()) {
      const err: ApiError = new Error("Checkout is turned off in demo mode. Connect the Worker in ts/config.ts to take real orders.");
      err.demo = true;
      throw err;
    }
    return fetchJSON<{ url?: string }>(cfg.apiBase.replace(/\/$/, "") + "/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: lines.map((l) => ({ variationId: l.variationId, qty: l.qty, modifiers: l.modifiers.map((m) => m.id) })),
        fulfillment
      })
    });
  }

  async function sendCommission(data: CommissionData) {
    return fetchJSON<{ ok: boolean; confirmationSent: boolean }>(cfg.apiBase.replace(/\/$/, "") + "/api/commission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
  }

  async function getReviews(): Promise<ReviewData> {
    const data = await fetchJSON<Partial<ReviewData>>(isDemo()
      ? siteRoot() + "data/demo-reviews.json"
      : cfg.apiBase.replace(/\/$/, "") + "/api/reviews");
    return { reviews: data.reviews || [], stats: data.stats || { count: 0, average: null, etsySales: null } };
  }

  // Sent as a form rather than JSON because it can carry photos.
  async function sendReview(data: FormData) {
    return fetchJSON<{ ok: boolean }>(cfg.apiBase.replace(/\/$/, "") + "/api/reviews", { method: "POST", body: data });
  }

  function money(cents: number | null | undefined): string {
    if (typeof cents !== "number") return "";
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: cfg.currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2
    }).format(cents / 100);
  }

  function priceLabel(p: Product): string {
    if (p.minPrice === null) return "";
    return p.minPrice === p.maxPrice ? money(p.minPrice) : `From ${money(p.minPrice)}`;
  }

  window.GC_API = { getProducts, getProduct, createCheckout, sendCommission, getReviews, sendReview, money, priceLabel, isDemo, siteRoot };
})();
