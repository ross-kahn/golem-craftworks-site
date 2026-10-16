// Home page: one tile per category, each showing a few of its pieces.
import * as api from "../api.ts";
import { skeletons, shopDown } from "../chrome.ts";
import { shopCategories, tilePhotos } from "../../../shared/catalog.ts";
import { esc } from "../../../shared/text.ts";

const grid = document.querySelector<HTMLElement>("[data-grid]")!;

// The same tile the Worker draws (worker/src/pages.ts), from available pieces only.
function tile(name: string, slug: string, list: Product[]) {
  const photos = tilePhotos(list.map((p) => p.images || []));
  const media = photos.length
    ? photos
        .map(
          (src) =>
            `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`,
        )
        .join("")
    : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`;
  return `
    <li class="cat">
      <a href="/shop/${esc(slug)}">
        <div class="cat__media" data-n="${photos.length}">${media}</div>
        <h3 class="cat__name">${esc(name)}</h3>
        <p class="cat__count">${list.length} ${list.length === 1 ? "piece" : "pieces"}</p>
      </a>
    </li>`;
}

function render(products: Product[]) {
  const cats = shopCategories(products.filter((p) => !p.soldOut));
  if (!cats.length) {
    grid.innerHTML = `<li class="empty">
      Nothing here right now. <a href="/commissions/">Ask about a commission</a>.</li>`;
    return;
  }
  grid.innerHTML = cats.map((c) => tile(c.name, c.slug, c.products)).join("");
}

// A quiet line of proof under the hero buttons: rating, review count, sales. Hidden until there's something to say.
api
  .getReviews()
  .then(({ stats }) => {
    const proof = document.querySelector<HTMLElement>("[data-proof]");
    const parts = [
      stats.average !== null
        ? `★ ${stats.average.toFixed(1)} from ${stats.count.toLocaleString("en-US")} ${stats.count === 1 ? "review" : "reviews"}`
        : "",
      stats.sales != null ? `${stats.sales.toLocaleString("en-US")} sales` : "",
    ].filter(Boolean);
    if (proof && parts.length) {
      proof.textContent = parts.join(" · ");
      proof.hidden = false;
    }
  })
  .catch(() => {
    /* the line just stays hidden */
  });

// The Worker may have filled the grid already; only show placeholders when it's empty.
if (!grid.children.length) grid.innerHTML = skeletons(2);

api
  .getProducts()
  .then(render)
  .catch(() => {
    grid.innerHTML = shopDown();
  });
