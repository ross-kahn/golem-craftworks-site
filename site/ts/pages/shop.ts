// Category page: the product grid for one category, with links to the others.
import * as api from "../api.ts";
import { skeletons, shopDown } from "../chrome.ts";
import { byCategory } from "../../../shared/catalog.ts";
import { esc, slugify } from "../../../shared/text.ts";

const grid = document.querySelector<HTMLElement>("[data-grid]")!;
const filtersEl = document.querySelector<HTMLElement>("[data-filters]")!;
const soldToggle =
  document.querySelector<HTMLInputElement>("[data-show-sold]")!;
let products: Product[] = [];
// The page's address is /shop/<slug>.
const slug = decodeURIComponent(location.pathname.split("/shop/")[1] || "");

function card(p: Product) {
  const img = p.images && p.images[0];
  const media = img
    ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`
    : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`;
  const mark = p.soldOut ? `<span class="soldmark">Sold</span>` : "";

  let stock = "";
  if (!p.soldOut && !p.unique) {
    const n = p.variations.reduce((a, v) => a + v.available, 0);
    if (n <= 3) stock = `${n} left`;
    else if (p.variations.length > 1) stock = `${p.variations.length} options`;
  }
  return `
    <li class="card${p.soldOut ? " card--sold" : ""}">
      <a href="${api.productLink(p)}">
        <div class="card__media">${media}${mark}</div>
        <h3 class="card__name">${esc(p.name)}</h3>
        <div class="card__meta">
          <span class="card__price">${p.soldOut ? "Sold" : api.priceLabel(p)}</span>
          ${stock ? `<span class="card__stock">${esc(stock)}</span>` : ""}
        </div>
      </a>
    </li>`;
}

function renderFilters() {
  const names = new Map<string, string>();
  products.forEach((p) => {
    if (!names.has(slugify(p.category)))
      names.set(slugify(p.category), p.category);
  });
  const cats = [...names].sort(([, a], [, b]) => byCategory(a, b));
  filtersEl.innerHTML = cats
    .map(
      ([s, name]) =>
        `<a class="chip" href="${esc(api.categoryLink(name))}"${s === slug ? ' aria-current="page"' : ""}>${esc(name)}</a>`,
    )
    .join("");
  return names.get(slug);
}

function render() {
  const showSold = soldToggle.checked;
  const list = products.filter(
    (p) => slugify(p.category) === slug && (showSold || !p.soldOut),
  );
  if (!list.length) {
    grid.innerHTML = `<li class="empty">
      Nothing here right now. ${showSold ? "" : `Turn on “Show sold pieces” to see past work, or `}
      <a href="/commissions/">ask about a commission</a>.</li>`;
    return;
  }
  grid.innerHTML = list.map(card).join("");
}

soldToggle.addEventListener("change", render);

// The Worker may have filled the grid already; only show placeholders when it's empty.
if (!grid.children.length) grid.innerHTML = skeletons(8);

api
  .getProducts()
  .then((data) => {
    products = data;
    const name = renderFilters();
    if (!name) {
      soldToggle.closest<HTMLElement>("label")!.hidden = true;
      grid.innerHTML = `<li class="empty">That category isn't here. <a href="/">Go to the shop</a>.</li>`;
      return;
    }
    document.title = `${name} · Golem Craftworks`;
    document
      .querySelectorAll<HTMLElement>("[data-category-name]")
      .forEach((el) => {
        el.textContent = name;
      });
    render();
  })
  .catch(() => {
    grid.innerHTML = shopDown();
  });
