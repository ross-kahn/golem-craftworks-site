"use strict";
// Home page: product grid with category filters.
(function () {
    const api = window.GC_API;
    const { esc, root } = window.GC;
    const grid = document.querySelector("[data-grid]");
    const filtersEl = document.querySelector("[data-filters]");
    const soldToggle = document.querySelector("[data-show-sold]");
    const noticeEl = document.querySelector("[data-notice]");
    let products = [];
    let category = new URLSearchParams(location.search).get("category") || "All";
    function card(p) {
        const img = p.images && p.images[0];
        const media = img
            ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`
            : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`;
        let mark = "";
        if (p.soldOut)
            mark = `<span class="soldmark">Sold</span>`;
        else if (p.unique)
            mark = `<span class="hexmark">One of a kind</span>`;
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
        <a href="${root}product/?id=${encodeURIComponent(p.id)}">
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
        const cats = ["All", ...new Set(products.map((p) => p.category).filter(Boolean))];
        if (!cats.includes(category))
            category = "All";
        filtersEl.innerHTML = cats.map((c) => `<button class="chip" type="button" aria-pressed="${c === category}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
    }
    function render() {
        const showSold = soldToggle.checked;
        const list = products.filter((p) => (category === "All" || p.category === category) && (showSold || !p.soldOut));
        if (!list.length) {
            grid.innerHTML = `<li class="empty" style="grid-column:1/-1">
        Nothing here right now. ${showSold ? "" : `Turn on “Show sold pieces” to see past work, or `}
        <a href="${root}commissions/">ask about a commission</a>.</li>`;
            return;
        }
        grid.innerHTML = list.map(card).join("");
    }
    filtersEl.addEventListener("click", (e) => {
        const b = e.target.closest("[data-cat]");
        if (!b)
            return;
        category = b.dataset.cat;
        const url = new URL(location.href);
        if (category === "All")
            url.searchParams.delete("category");
        else
            url.searchParams.set("category", category);
        history.replaceState(null, "", url);
        renderFilters();
        render();
    });
    soldToggle.addEventListener("change", render);
    grid.innerHTML = Array.from({ length: 8 }, () => `<li><div class="skeleton"></div><div class="skeleton-line"></div></li>`).join("");
    api.getProducts()
        .then((data) => {
        products = data;
        if (api.isDemo()) {
            noticeEl.hidden = false;
            noticeEl.innerHTML = `<p>Demo mode: these are sample products. Set <code>apiBase</code> to "/" in ts/config.ts and run <code>npm run deploy</code> to show your live Square inventory.</p>`;
        }
        renderFilters();
        render();
    })
        .catch(() => {
        grid.innerHTML = `<li class="empty" style="grid-column:1/-1">The shop couldn't load right now. Refresh the page, or find me on <a href="${esc(window.GC_CONFIG.etsyUrl)}">Etsy</a> in the meantime.</li>`;
    });
})();
