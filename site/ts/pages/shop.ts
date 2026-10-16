// Category page: the product grid for one category, with links to the others.
import * as api from "../api.ts";
import { skeletons, shopDown } from "../chrome.ts";
import { shopCategories } from "../../../shared/catalog.ts";
import { esc } from "../../../shared/text.ts";

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
  const mark = p.soldOut
    ? `<span class="soldmark">Sold</span>`
    : api.saleOff(p)
      ? `<span class="salemark">Sale</span>`
      : "";

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
          <span class="card__price">${p.soldOut ? "Sold" : api.priceHtml(p)}</span>
          ${stock ? `<span class="card__stock">${esc(stock)}</span>` : ""}
        </div>
      </a>
    </li>`;
}

// This page's category, once the products are in.
let shelf: Product[] = [];

function renderFilters() {
  const cats = shopCategories(products);
  filtersEl.innerHTML = cats
    .map(
      (c) =>
        `<a class="chip" href="/shop/${esc(c.slug)}"${c.slug === slug ? ' aria-current="page"' : ""}>${esc(c.name)}</a>`,
    )
    .join("");
  const here = cats.find((c) => c.slug === slug);
  shelf = here?.products || [];
  return here?.name;
}

function render() {
  const showSold = soldToggle.checked;
  const list = shelf.filter((p) => showSold || !p.soldOut);
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
