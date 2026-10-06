// Site settings. Edit these, nothing else needs to change for a basic launch.
// After editing, run `npm run build` to update js/config.js.
window.GC_CONFIG = {
  apiBase: "/",

  shopName: "Golem Craftworks",
  contactEmail: "golemcraftworks@gmail.com",
  instagramUrl: "https://www.instagram.com/golem_craftworks/",
  etsyUrl: "https://golemcraftworks.etsy.com",

  // Optional spam check on the review form (Cloudflare Turnstile). Leave empty to go without it.
  // Needs the matching TURNSTILE_SECRET set on the Worker.
  turnstileSiteKey: "",

  // Shown in the cart. The real amount is enforced by the Worker (SHIPPING_FLAT_CENTS).
  shippingLabel: "Flat-rate shipping, US only",
  shippingCents: 800,
  pickupLabel: "Local pickup or drop-off in Madison, WI",
  pickupNote: "I'll email you to set a time.",

  currency: "USD"
};
