// Who the shop is and how to reach it, written once. The site's footer and the business data search
// engines read come from here. site/contact/ writes the same details out (a test checks they match).
// Keep it matching the business information in Google Merchant Center.
import { esc } from "./text.ts";

export const BUSINESS = {
  name: "Golem Craftworks",
  legalName: "Golem Craftworks LLC",
  email: "ross@golemcraftworks.com",
  phone: "(608) 571-4739",
  phoneLink: "tel:+16085714739",
  city: "Madison",
  region: "WI",
  regionName: "Wisconsin",
  country: "US",
  instagramUrl: "https://www.instagram.com/golem_craftworks/",
  etsyUrl: "https://golemcraftworks.etsy.com",
};

// The footer on every page. The Worker puts it in the page it sends, so it's there without scripts,
// and chrome.ts draws the same thing in the browser.
export function siteFooter(year: number) {
  const b = BUSINESS;
  return `
    <div class="wrap">
      <div class="site-footer__inner">
        <div>
          <a class="brand" href="/">
            <img src="/assets/logo.png" alt="" width="52" height="60">
            <span class="brand__name">${esc(b.name)}</span>
          </a>
          <p class="site-footer__tagline">Hardwood boxes, game sets, and dice, made by hand in ${esc(b.city)}, ${esc(b.regionName)}.</p>
        </div>
        <div>
          <h3>Shop</h3>
          <ul>
            <li><a href="/">All products</a></li>
            <li><a href="/commissions/">Commissions</a></li>
            <li><a href="/reviews/">Reviews</a></li>
            <li><a href="/about/">About</a></li>
          </ul>
        </div>
        <div>
          <h3>Help</h3>
          <ul>
            <li><a href="/contact/">Contact</a></li>
            <li><a href="/shipping/">Shipping and returns</a></li>
            <li><a href="/privacy/">Privacy policy</a></li>
          </ul>
        </div>
        <div>
          <h3>Get in touch</h3>
          <ul>
            <li><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>
            <li><a href="${esc(b.phoneLink)}">${esc(b.phone)}</a></li>
            <li><a href="${esc(b.instagramUrl)}" rel="noopener">Instagram</a></li>
            <li><a href="${esc(b.etsyUrl)}" rel="noopener">Etsy</a></li>
          </ul>
        </div>
      </div>
      <p class="site-footer__legal">© ${year} ${esc(b.legalName)}, ${esc(b.city)}, ${esc(b.region)}. Payments are processed securely by Square.</p>
    </div>`;
}

// The business as search engines read it (schema.org), for the home and contact pages.
export function businessData(siteUrl: string) {
  const b = BUSINESS;
  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    name: b.name,
    legalName: b.legalName,
    url: `${siteUrl}/`,
    logo: `${siteUrl}/assets/logo.png`,
    email: b.email,
    telephone: b.phone,
    address: {
      "@type": "PostalAddress",
      addressLocality: b.city,
      addressRegion: b.region,
      addressCountry: b.country,
    },
    sameAs: [b.instagramUrl, b.etsyUrl],
    hasMerchantReturnPolicy: {
      "@type": "MerchantReturnPolicy",
      applicableCountry: b.country,
      returnPolicyCategory:
        "https://schema.org/MerchantReturnFiniteReturnWindow",
      merchantReturnDays: 60,
      returnMethod: "https://schema.org/ReturnByMail",
      returnFees: "https://schema.org/ReturnShippingFees",
      merchantReturnLink: `${siteUrl}/shipping/`,
    },
  };
}
