// Product page: gallery, option picker, add to cart.
(function () {
  const api = window.GC_API;
  const { esc, root, cart, openCart, toast } = window.GC;
  const mount = document.querySelector<HTMLElement>("[data-product]")!;
  const id = new URLSearchParams(location.search).get("id");

  function notFound() {
    document.title = "Not found · Golem Craftworks";
    mount.innerHTML = `
      <div class="thanks">
        <h1>That piece isn't here.</h1>
        <p>It may have sold or been taken down. Everything available is in the shop.</p>
        <a class="btn" href="${root}">Browse the shop</a>
      </div>`;
  }

  function stockText(p: Product, v: Variation) {
    if (v.available === 0) return { text: "Sold", cls: "" };
    if (p.unique) return { text: "One of a kind. When it's gone, it's gone.", cls: "product__stock--unique" };
    if (v.qty === null || v.qty === undefined) return { text: "Made to order", cls: "" };
    if (v.available <= 3) return { text: `${v.available} left`, cls: "" };
    return { text: "In stock", cls: "" };
  }

  // What Square's min/max rules mean for the buyer, when it isn't obvious from the options.
  function listHint(l: ModifierList) {
    if (l.modifiers.length === 1) return l.min ? "" : "Optional";
    if (l.min === l.max) return `Choose ${l.min}`;
    if (l.min === 0) return l.max === l.modifiers.length ? "Optional" : `Optional, up to ${l.max}`;
    return l.max === l.modifiers.length ? `Choose at least ${l.min}` : `Choose ${l.min} to ${l.max}`;
  }

  function render(p: Product) {
    document.title = `${p.name} · Golem Craftworks`;
    const firstAvail = p.variations.find((v) => v.available > 0) || p.variations[0];
    const images = p.images && p.images.length ? p.images : [];
    const multi = p.variations.length > 1;

    mount.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb">
        <a href="${root}">Shop</a>${p.category ? ` / <a href="${root}?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a>` : ""}
      </nav>
      <div class="product">
        <div class="gallery">
          <div class="gallery__main">
            ${images.length ? `<img src="${esc(images[0])}" alt="${esc(p.name)}" data-main>` : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`}
          </div>
          ${images.length > 1 ? `<div class="gallery__thumbs">${images.map((src, i) =>
            `<button type="button" data-thumb="${i}" aria-current="${i === 0}" aria-label="Photo ${i + 1} of ${images.length}"><img src="${esc(src)}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
        </div>
        <div class="product__info">
          <h1>${esc(p.name)}</h1>
          <p class="product__price" data-price>${api.money(firstAvail.priceCents)}</p>
          <p class="product__stock" data-stock></p>
          ${multi ? `
            <fieldset class="picker">
              <legend>${esc(p.optionLabel || "Option")}</legend>
              <div class="picker__options">
                ${p.variations.map((v) => `
                  <label class="picker__option">
                    <input type="radio" name="variation" value="${esc(v.id)}" ${v.id === firstAvail.id ? "checked" : ""} ${v.available === 0 ? "disabled" : ""}>
                    <span>${esc(v.name)}${v.available === 0 ? " (sold out)" : ""}</span>
                  </label>`).join("")}
              </div>
            </fieldset>` : ""}
          ${p.modifierLists.map((l) => `
            <fieldset class="picker" data-list="${esc(l.id)}">
              <legend>${esc(l.name)}${listHint(l) ? ` <small class="picker__hint">${listHint(l)}</small>` : ""}</legend>
              <div class="picker__options">
                ${l.modifiers.map((m) => `
                  <label class="picker__option">
                    <input type="${l.min === 1 && l.max === 1 ? "radio" : "checkbox"}" name="mod-${esc(l.id)}" value="${esc(m.id)}" ${m.default ? "checked" : ""}>
                    <span>${esc(m.name)}${m.priceCents ? ` (${m.priceCents > 0 ? "+" : "−"}${api.money(Math.abs(m.priceCents))})` : ""}</span>
                  </label>`).join("")}
              </div>
            </fieldset>`).join("")}
          <div class="product__buy">
            <button class="btn btn--block" type="button" data-add>Add to cart</button>
          </div>
          <div class="product__desc">
            ${(p.description || "").split(/\n{2,}/).map((para) => `<p>${esc(para)}</p>`).join("")}
          </div>
          <div class="product__aside">
            <p><strong style="font-family:var(--font-display)">Shipping or pickup.</strong> Ships flat-rate in the US, or pick up in Madison for free.</p>
            <p>Want it engraved or made in a different wood? <a href="${root}commissions/">Start a commission</a>.</p>
          </div>
        </div>
      </div>`;

    let current = firstAvail;
    const priceEl = mount.querySelector<HTMLElement>("[data-price]")!;
    const stockEl = mount.querySelector<HTMLElement>("[data-stock]")!;
    const addBtn = mount.querySelector<HTMLButtonElement>("[data-add]")!;

    const checked = (l: ModifierList) =>
      [...mount.querySelectorAll<HTMLInputElement>(`[name="mod-${CSS.escape(l.id)}"]:checked`)].map((i) => i.value);
    const selected = () => p.modifierLists.flatMap((l) => l.modifiers.filter((m) => checked(l).includes(m.id)));

    function update() {
      const s = stockText(p, current);
      const mods = selected();
      priceEl.textContent = api.money(current.priceCents + mods.reduce((n, m) => n + m.priceCents, 0));
      stockEl.textContent = s.text;
      stockEl.className = "product__stock " + s.cls;
      const inCart = cart.lines().reduce((n, l) => n + (l.variationId === current.id ? l.qty : 0), 0);
      const short = p.modifierLists.find((l) => checked(l).length < l.min);
      delete addBtn.dataset.view;
      if (current.available === 0) {
        addBtn.disabled = true; addBtn.textContent = "Sold";
      } else if (inCart >= current.available) {
        addBtn.disabled = false; addBtn.textContent = "In your cart · view cart";
        addBtn.dataset.view = "1";
      } else if (short) {
        addBtn.disabled = true; addBtn.textContent = `Choose ${short.name.toLowerCase()} to continue`;
      } else {
        addBtn.disabled = false; addBtn.textContent = "Add to cart";
      }
    }

    mount.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === "variation") {
        current = p.variations.find((v) => v.id === input.value) || current;
        update();
      }
      const list = p.modifierLists.find((l) => input.name === `mod-${l.id}`);
      if (list) {
        // Past the limit: with one choice allowed the new pick replaces the old one, otherwise it's refused.
        const over = checked(list).length > list.max;
        if (over && list.max === 1) {
          mount.querySelectorAll<HTMLInputElement>(`[name="${CSS.escape(input.name)}"]`).forEach((i) => { i.checked = i === input; });
        } else if (over) {
          input.checked = false;
          toast(`Choose up to ${list.max}.`);
        }
        update();
      }
    });
    mount.addEventListener("click", (e) => {
      const target = e.target as Element;
      const thumb = target.closest<HTMLElement>("[data-thumb]");
      if (thumb) {
        const i = Number(thumb.dataset.thumb);
        mount.querySelector<HTMLImageElement>("[data-main]")!.src = images[i];
        mount.querySelectorAll("[data-thumb]").forEach((b) => b.setAttribute("aria-current", String(b === thumb)));
      }
      if (target.closest("[data-add]")) {
        if (addBtn.dataset.view) { openCart(); return; }
        const r = cart.add(p, current, 1, selected());
        if (r.ok) { toast(`Added ${p.name} to your cart`); update(); }
        else toast(r.reason);
      }
    });
    update();
  }

  if (!id) { notFound(); return; }
  api.getProduct(id).then((p) => (p ? render(p) : notFound())).catch(() => {
    mount.innerHTML = `<div class="thanks"><h1>This page couldn't load.</h1><p>Refresh to try again.</p></div>`;
  });
})();
