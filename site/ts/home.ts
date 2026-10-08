// Home page: one tile per category, each showing a few of its pieces.
(function () {
  const api = window.GC_API;
  const { esc, root } = window.GC;
  const grid = document.querySelector<HTMLElement>("[data-grid]")!;
  const noticeEl = document.querySelector<HTMLElement>("[data-notice]")!;

  // Up to four photos: one from each piece, newest first, then their second photos, and so on.
  function tilePhotos(list: Product[]) {
    const out: string[] = [];
    const images = list.map((p) => p.images || []);
    for (
      let i = 0;
      out.length < 4 && images.some((imgs) => imgs.length > i);
      i++
    ) {
      for (const imgs of images)
        if (imgs[i] && out.length < 4) out.push(imgs[i]);
    }
    return out;
  }

  // The same tile the Worker draws (worker/src/pages.ts), from available pieces only.
  function tile(name: string, list: Product[]) {
    const photos = tilePhotos(list);
    const media = photos.length
      ? photos
          .map(
            (src) =>
              `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">`,
          )
          .join("")
      : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`;
    return `
      <li class="cat">
        <a href="${esc(api.categoryLink(name))}">
          <div class="cat__media" data-n="${photos.length}">${media}</div>
          <h3 class="cat__name">${esc(name)}</h3>
          <p class="cat__count">${list.length} ${list.length === 1 ? "piece" : "pieces"}</p>
        </a>
      </li>`;
  }

  function render(products: Product[]) {
    const bySlug = new Map<string, { name: string; list: Product[] }>();
    products
      .filter((p) => !p.soldOut)
      .forEach((p) => {
        const slug = api.slugify(p.category);
        const c = bySlug.get(slug) || { name: p.category, list: [] };
        c.list.push(p);
        bySlug.set(slug, c);
      });
    // A to Z, with "Other" last.
    const cats = [...bySlug.values()].sort(
      (a, b) =>
        Number(a.name === "Other") - Number(b.name === "Other") ||
        a.name.localeCompare(b.name),
    );
    if (!cats.length) {
      grid.innerHTML = `<li class="empty" style="grid-column:1/-1">
        Nothing here right now. <a href="${root}commissions/">Ask about a commission</a>.</li>`;
      return;
    }
    grid.innerHTML = cats.map((c) => tile(c.name, c.list)).join("");
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
        stats.sales != null
          ? `${stats.sales.toLocaleString("en-US")} sales`
          : "",
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
  if (!grid.children.length)
    grid.innerHTML = Array.from(
      { length: 2 },
      () =>
        `<li><div class="skeleton"></div><div class="skeleton-line"></div></li>`,
    ).join("");

  api
    .getProducts()
    .then((products) => {
      if (api.isDemo()) {
        noticeEl.hidden = false;
        noticeEl.innerHTML = `<p>Demo mode: these are sample products. Set <code>apiBase</code> to "/" in ts/config.ts and run <code>npm run deploy</code> to show your live Square inventory.</p>`;
      }
      render(products);
    })
    .catch(() => {
      grid.innerHTML = `<li class="empty" style="grid-column:1/-1">The shop couldn't load right now. Refresh the page, or find me on <a href="${esc(window.GC_CONFIG.etsyUrl)}">Etsy</a> in the meantime.</li>`;
    });
})();
