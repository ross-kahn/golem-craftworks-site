// Site settings. After editing, `npm run deploy` puts them live.
// This is its own script so the Worker can serve it with the shipping price filled in.
window.GC_CONFIG = {
  shopName: "Golem Craftworks",
  contactEmail: "ross@golemcraftworks.com",
  instagramUrl: "https://www.instagram.com/golem_craftworks/",
  etsyUrl: "https://golemcraftworks.etsy.com",

  // Optional spam check on the review form (Cloudflare Turnstile). Leave empty to go without it.
  // Needs the matching TURNSTILE_SECRET set on the Worker.
  turnstileSiteKey: "0x4AAAAAAFQn6FgSfJO7ndZm",

  shippingLabel: "Flat-rate shipping, US only",
  // Don't change the price here. The Worker replaces this with SHIPPING_FLAT_CENTS from
  // worker/wrangler.toml, the one place the shipping price is set.
  shippingCents: 800,
  pickupLabel: "Local pickup or drop-off in Madison, WI",
  pickupNote: "I'll email you to set a time.",

  currency: "USD",
};
