"use strict";
// Site settings. Edit these, nothing else needs to change for a basic launch.
// After editing, run `npm run build` to update js/config.js.
window.GC_CONFIG = {
    // Where the Cloudflare Worker lives. Leave empty ("") to run the site in
    // demo mode with the sample products in data/demo-products.json.
    apiBase: "", // e.g. "https://api.golemcraftworks.com"
    shopName: "Golem Craftworks",
    contactEmail: "golemcraftworks@gmail.com",
    instagramUrl: "https://www.instagram.com/", // TODO: your handle
    etsyUrl: "https://www.etsy.com/shop/", // TODO: your shop
    // Shown in the cart. The real amount is enforced by the Worker (SHIPPING_FLAT_CENTS).
    shippingLabel: "Flat-rate shipping, US only",
    shippingCents: 800,
    pickupLabel: "Local pickup or drop-off in Madison, WI",
    pickupNote: "I'll email you to set a time.",
    currency: "USD"
};
