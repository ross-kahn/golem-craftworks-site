"use strict";
// Category page: the product grid for one category, with links to the others.
(function () {
    const api = window.GC_API;
    const { esc, root } = window.GC;
    const grid = document.querySelector("[data-grid]");
    const filtersEl = document.querySelector("[data-filters]");
    const soldToggle = document.querySelector("[data-show-sold]");
    const noticeEl = document.querySelector("[data-notice]");
    let products = [];
    // /shop/<slug> when the Worker serves the page, /shop/?category=… in demo mode.
    const slug = api.slugify(new URLSearchParams(location.search).get("category") ||
        decodeURIComponent((location.pathname.split("/shop/")[1] || "").replace(/\/$/, "")));
    // The Worker serves each product at a readable address. Demo mode has no Worker, so it uses the plain page.
    const productLink = (p) => api.isDemo() || !p.slug
        ? `${root}product/?id=${encodeURIComponent(p.id)}`
        : `${root}product/${encodeURIComponent(p.slug)}`;
    function card(p) {
        const img = p.images && p.images[0];
        const media = img
            ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`
            : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`;
        const mark = p.soldOut ? `<span class="soldmark">Sold</span>` : "";
        let stock = "";
        if (!p.soldOut && !p.unique) {
            const n = p.variations.reduce((a, v) => a + v.available, 0);
            if (n <= 3)
                stock = `${n} left`;
            else if (p.variations.length > 1)
                stock = `${p.variations.length} options`;
        }
        return `
      <li class="card${p.soldOut ? " card--sold" : ""}">
        <a href="${productLink(p)}">
          <div class="card__media">${media}${mark}</div>
          <h3 class="card__name">${esc(p.name)}</h3>
          <div class="card__meta">
            <span class="card__price">${p.soldOut ? "Sold" : api.priceLabel(p)}</span>
            ${stock ? `<span class="card__stock">${esc(stock)}</span>` : ""}
          </div>
        </a>
      </li>`;
    }
    // A to Z, with "Other" last: the same order as the home page.
    function renderFilters() {
        const names = new Map();
        products.forEach((p) => {
            if (!names.has(api.slugify(p.category)))
                names.set(api.slugify(p.category), p.category);
        });
        const cats = [...names].sort(([, a], [, b]) => Number(a === "Other") - Number(b === "Other") || a.localeCompare(b));
        filtersEl.innerHTML = cats
            .map(([s, name]) => `<a class="chip" href="${esc(api.categoryLink(name))}"${s === slug ? ' aria-current="page"' : ""}>${esc(name)}</a>`)
            .join("");
        return names.get(slug);
    }
    function render() {
        const showSold = soldToggle.checked;
        const list = products.filter((p) => api.slugify(p.category) === slug && (showSold || !p.soldOut));
        if (!list.length) {
            grid.innerHTML = `<li class="empty" style="grid-column:1/-1">
        Nothing here right now. ${showSold ? "" : `Turn on “Show sold pieces” to see past work, or `}
        <a href="${root}commissions/">ask about a commission</a>.</li>`;
            return;
        }
        grid.innerHTML = list.map(card).join("");
    }
    soldToggle.addEventListener("change", render);
    // The Worker may have filled the grid already; only show placeholders when it's empty.
    if (!grid.children.length)
        grid.innerHTML = Array.from({ length: 8 }, () => `<li><div class="skeleton"></div><div class="skeleton-line"></div></li>`).join("");
    api
        .getProducts()
        .then((data) => {
        products = data;
        if (api.isDemo()) {
            noticeEl.hidden = false;
            noticeEl.innerHTML = `<p>Demo mode: these are sample products. Set <code>apiBase</code> to "/" in ts/config.ts and run <code>npm run deploy</code> to show your live Square inventory.</p>`;
        }
        const name = renderFilters();
        if (!name) {
            soldToggle.closest("label").hidden = true;
            grid.innerHTML = `<li class="empty" style="grid-column:1/-1">That category isn't here. <a href="${root}">Go to the shop</a>.</li>`;
            return;
        }
        document.title = `${name} · Golem Craftworks`;
        document
            .querySelectorAll("[data-category-name]")
            .forEach((el) => {
            el.textContent = name;
        });
        render();
    })
        .catch(() => {
        grid.innerHTML = `<li class="empty" style="grid-column:1/-1">The shop couldn't load right now. Refresh the page, or find me on <a href="${esc(window.GC_CONFIG.etsyUrl)}">Etsy</a> in the meantime.</li>`;
    });
})();
