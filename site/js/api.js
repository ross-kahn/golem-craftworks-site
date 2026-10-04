"use strict";
// Talks to the Cloudflare Worker (or demo data when no Worker is configured).
(function () {
    const cfg = window.GC_CONFIG;
    const CACHE_KEY = "gc-products-v1";
    const CACHE_MS = 60 * 1000;
    const isDemo = () => !cfg.apiBase;
    function siteRoot() {
        // Works whether the site is served from the domain root or a subfolder (e.g. a preview).
        const s = document.querySelector('script[src$="js/api.js"]');
        return s ? s.src.replace(/js\/api\.js.*$/, "") : "/";
    }
    async function fetchJSON(url, opts) {
        const res = await fetch(url, opts);
        let body = null;
        try {
            body = await res.json();
        }
        catch (_) { /* non-JSON */ }
        if (!res.ok) {
            const err = new Error((body && body.error) || `Request failed (${res.status})`);
            err.status = res.status;
            err.body = body;
            throw err;
        }
        return body;
    }
    async function getProducts({ fresh = false } = {}) {
        if (!fresh) {
            try {
                const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
                if (hit && Date.now() - hit.t < CACHE_MS)
                    return hit.data;
            }
            catch (_) { /* storage unavailable */ }
        }
        const url = isDemo()
            ? siteRoot() + "data/demo-products.json"
            : cfg.apiBase.replace(/\/$/, "") + "/api/products";
        const data = await fetchJSON(url);
        const products = (data.products || []).map(normalize);
        try {
            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data: products }));
        }
        catch (_) { }
        return products;
    }
    function normalize(p) {
        const variations = (p.variations || []).map((v) => ({
            ...v,
            // qty null means Square isn't tracking stock for it: treat as available.
            available: v.qty === null || v.qty === undefined ? 99 : Math.max(0, v.qty)
        }));
        const totalAvailable = variations.reduce((n, v) => n + v.available, 0);
        const prices = variations.map((v) => v.priceCents).filter((n) => typeof n === "number");
        return {
            ...p,
            variations,
            soldOut: totalAvailable === 0,
            // One-of-a-kind: a single variation with exactly one in stock, or flagged in Square.
            unique: p.unique === true || (variations.length === 1 && variations[0].qty === 1),
            minPrice: prices.length ? Math.min(...prices) : null,
            maxPrice: prices.length ? Math.max(...prices) : null
        };
    }
    async function getProduct(id) {
        const all = await getProducts();
        return all.find((p) => p.id === id || p.slug === id) || null;
    }
    async function createCheckout({ lines, fulfillment }) {
        if (isDemo()) {
            const err = new Error("Checkout is turned off in demo mode. Connect the Worker in ts/config.ts to take real orders.");
            err.demo = true;
            throw err;
        }
        return fetchJSON(cfg.apiBase.replace(/\/$/, "") + "/api/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                lines: lines.map((l) => ({ variationId: l.variationId, qty: l.qty })),
                fulfillment
            })
        });
    }
    async function sendCommission(data) {
        return fetchJSON(cfg.apiBase.replace(/\/$/, "") + "/api/commission", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data)
        });
    }
    function money(cents) {
        if (typeof cents !== "number")
            return "";
        return new Intl.NumberFormat("en-US", {
            style: "currency", currency: cfg.currency,
            minimumFractionDigits: cents % 100 === 0 ? 0 : 2
        }).format(cents / 100);
    }
    function priceLabel(p) {
        if (p.minPrice === null)
            return "";
        return p.minPrice === p.maxPrice ? money(p.minPrice) : `From ${money(p.minPrice)}`;
    }
    window.GC_API = { getProducts, getProduct, createCheckout, sendCommission, money, priceLabel, isDemo, siteRoot };
})();
