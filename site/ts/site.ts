// Shared page chrome (header, footer, cart drawer) and the cart itself.
(function () {
  const cfg = window.GC_CONFIG;
  const api = window.GC_API;
  const root = api.siteRoot();
  const CART_KEY = "gc-cart-v2";
  const FULFIL_KEY = "gc-fulfillment";
  const THEME_KEY = "gc-theme"; // also read by theme.ts

  const icons = {
    bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 8h14l-1 13H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h18M3 12h18M3 17h18"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    moon: '<svg class="when-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    sun: '<svg class="when-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  };

  const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // ---------- Cart store ----------
  let memoryCart: CartLine[] = [];
  function readCart(): CartLine[] {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch (_) { return memoryCart; }
  }
  function writeCart(lines: CartLine[]) {
    memoryCart = lines;
    try { localStorage.setItem(CART_KEY, JSON.stringify(lines)); } catch (_) {}
    renderCount(); renderDrawer();
  }
  function getFulfillment(): Fulfillment {
    try { return (localStorage.getItem(FULFIL_KEY) || "ship") as Fulfillment; } catch (_) { return "ship"; }
  }
  function setFulfillment(v: string) { try { localStorage.setItem(FULFIL_KEY, v); } catch (_) {} renderDrawer(); }

  // How many of a variation are in the cart across all of its lines.
  const inCart = (lines: CartLine[], variationId: string) =>
    lines.reduce((n, l) => n + (l.variationId === variationId ? l.qty : 0), 0);

  const cart: GCCart = {
    lines: readCart,
    count: () => readCart().reduce((n, l) => n + l.qty, 0),
    add(product, variation, qty = 1, modifiers = []) {
      const lines = readCart();
      const key = [variation.id, ...modifiers.map((m) => m.id).sort()].join("|");
      const existing = lines.find((l) => l.key === key);
      const max = variation.available;
      const room = max - inCart(lines, variation.id);
      if (room <= 0) return { ok: false, reason: max === 1 ? "That piece is already in your cart." : `Only ${max} available.` };
      lines.forEach((l) => { if (l.variationId === variation.id) l.max = max; });
      if (existing) {
        existing.qty += Math.min(qty, room);
      } else {
        lines.push({
          key,
          variationId: variation.id,
          productId: product.id,
          name: product.name,
          variationName: product.variations.length > 1 ? variation.name : "",
          modifiers: modifiers.map((m) => ({ id: m.id, name: m.name })),
          priceCents: variation.priceCents + modifiers.reduce((n, m) => n + m.priceCents, 0),
          image: (product.images && product.images[0]) || "",
          qty: Math.min(qty, room),
          max
        });
      }
      writeCart(lines);
      return { ok: true };
    },
    setQty(key, qty) {
      let lines = readCart();
      lines = lines.map((l) => (l.key === key ? { ...l, qty } : l)).filter((l) => l.qty > 0);
      writeCart(lines);
    },
    clear() { writeCart([]); }
  };

  // ---------- Theme ----------
  // theme.ts picks the starting theme in <head>; this flips it and remembers the choice.
  // The switch names the theme it leads to; CSS shows the half that applies.
  const themeLabel = '<span class="when-light">Dark mode</span><span class="when-dark">Light mode</span>';
  const themeTip = () => (document.documentElement.dataset.theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    document.querySelectorAll<HTMLElement>(".theme-btn").forEach((b) => { b.title = themeTip(); });
  }

  // ---------- Chrome ----------
  function header(active: string | undefined) {
    const link = (href: string, label: string, key: string) =>
      `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
    const links = [
      link(root, "Shop", "shop"),
      link(root + "commissions/", "Commissions", "commissions"),
      link(root + "reviews/", "Reviews", "reviews"),
      link(root + "about/", "About", "about")
    ].join("");
    return `
      <a class="skip-link" href="#main">Skip to content</a>
      <div class="wrap site-header__inner">
        <a class="brand" href="${root}">
          <img src="${root}assets/logo.png" alt="" width="46" height="53">
          <span class="brand__name">${esc(cfg.shopName)}</span>
        </a>
        <nav class="nav" aria-label="Main">${links}</nav>
        <button class="icon-btn theme-btn" type="button" data-theme-toggle title="${themeTip()}">
          ${icons.moon}${icons.sun}<span class="visually-hidden">${themeLabel}</span>
        </button>
        <button class="cart-btn" type="button" data-open-cart aria-haspopup="dialog">
          ${icons.bag}<span class="visually-hidden">Cart,</span>
          <span class="cart-btn__count" data-cart-count data-empty="true">0</span>
          <span class="visually-hidden">items</span>
        </button>
        <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mobile-nav" data-menu>
          ${icons.menu}<span class="visually-hidden">Menu</span>
        </button>
      </div>
      <nav class="mobile-nav" id="mobile-nav" aria-label="Main">${links}
        <button type="button" data-theme-toggle>${icons.moon}${icons.sun}${themeLabel}</button>
      </nav>`;
  }

  function footer() {
    const year = new Date().getFullYear();
    return `
      <div class="wrap">
        <div class="site-footer__inner">
          <div>
            <a class="brand" href="${root}">
              <img src="${root}assets/logo.png" alt="" width="52" height="60">
              <span class="brand__name">${esc(cfg.shopName)}</span>
            </a>
            <p style="margin-top:16px">Hardwood boxes, game sets, and dice, made by hand in Madison, Wisconsin.</p>
          </div>
          <div>
            <h3>Shop</h3>
            <ul>
              <li><a href="${root}">All products</a></li>
              <li><a href="${root}commissions/">Commissions</a></li>
              <li><a href="${root}reviews/">Reviews</a></li>
              <li><a href="${root}about/">About</a></li>
            </ul>
          </div>
          <div>
            <h3>Elsewhere</h3>
            <ul>
              <li><a href="${esc(cfg.instagramUrl)}" rel="noopener">Instagram</a></li>
              <li><a href="${esc(cfg.etsyUrl)}" rel="noopener">Etsy</a></li>
              <li><a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a></li>
            </ul>
          </div>
        </div>
        <p class="site-footer__legal">© ${year} ${esc(cfg.shopName)} LLC. Payments are processed securely by Square.</p>
      </div>`;
  }

  function drawerShell() {
    return `
      <div class="drawer-backdrop" data-close-cart></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title" tabindex="-1">
        <div class="drawer__head">
          <h2 id="cart-title">Your cart</h2>
          <button class="icon-btn" type="button" data-close-cart>${icons.close}<span class="visually-hidden">Close cart</span></button>
        </div>
        <div class="drawer__body" data-drawer-body></div>
        <div class="drawer__foot" data-drawer-foot></div>
      </aside>
      <div class="toast" role="status" aria-live="polite" data-toast></div>`;
  }

  function renderCount() {
    const n = cart.count();
    document.querySelectorAll<HTMLElement>("[data-cart-count]").forEach((el) => {
      el.textContent = String(n); el.dataset.empty = n === 0 ? "true" : "false";
    });
  }

  let checkoutError = "";
  let lineNotes: Record<string, string> = {};

  function renderDrawer() {
    const body = document.querySelector("[data-drawer-body]");
    const foot = document.querySelector("[data-drawer-foot]");
    if (!body || !foot) return;
    const lines = readCart();
    if (!lines.length) {
      body.innerHTML = `
        <div class="drawer__empty">
          <img src="${root}assets/logo.png" alt="">
          <p><strong style="font-family:var(--font-display)">Your cart is empty.</strong></p>
          <p>Pieces you add will wait here while you browse.</p>
          <a class="btn btn--ghost" href="${root}" data-close-cart>Browse the shop</a>
        </div>`;
      foot.innerHTML = "";
      return;
    }
    body.innerHTML = lines.map((l) => {
      const note = lineNotes[l.key];
      const variant = [l.variationName, ...l.modifiers.map((m) => m.name)].filter(Boolean).join(" · ");
      return `
      <div class="line">
        <div class="line__img">${l.image ? `<img src="${esc(l.image)}" alt="">` : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`}</div>
        <div>
          <p class="line__name">${esc(l.name)}</p>
          <p class="line__variant">${esc(variant)}</p>
          ${l.max <= 1
            ? `<button class="text-btn" type="button" data-remove="${esc(l.key)}">Remove</button>`
            : `<div class="qty" role="group" aria-label="Quantity for ${esc(l.name)}">
                 <button type="button" data-dec="${esc(l.key)}" aria-label="Decrease">−</button>
                 <output>${l.qty}</output>
                 <button type="button" data-inc="${esc(l.key)}" aria-label="Increase" ${inCart(lines, l.variationId) >= l.max ? "disabled" : ""}>+</button>
               </div>`}
          ${note ? `<p class="line__note line__note--warn">${esc(note)}</p>` : ""}
        </div>
        <div class="line__price">${api.money(l.priceCents * l.qty)}</div>
      </div>`;
    }).join("");

    const subtotal = lines.reduce((n, l) => n + l.priceCents * l.qty, 0);
    const f = getFulfillment();
    const shipping = f === "ship" ? cfg.shippingCents : 0;
    foot.innerHTML = `
      <fieldset class="fulfil">
        <legend>Delivery</legend>
        <label><input type="radio" name="fulfil" value="ship" ${f === "ship" ? "checked" : ""}>
          <span><strong>Ship it · ${api.money(cfg.shippingCents)}</strong><small>${esc(cfg.shippingLabel)}</small></span></label>
        <label><input type="radio" name="fulfil" value="pickup" ${f === "pickup" ? "checked" : ""}>
          <span><strong>Pick up · free</strong><small>${esc(cfg.pickupLabel)}. ${esc(cfg.pickupNote)}</small></span></label>
      </fieldset>
      <p class="totals"><span>Subtotal</span><span>${api.money(subtotal + shipping)}</span></p>
      <p class="totals-note">${f === "ship" ? "Includes shipping. " : ""}Sales tax is added at checkout.</p>
      <button class="btn btn--block" type="button" data-checkout>Check out securely with Square</button>
      ${checkoutError ? `<p class="form-error" role="alert">${esc(checkoutError)}</p>` : ""}`;
  }

  // Re-check every cart line against live stock before sending people to pay.
  async function reconcileCart() {
    const products = await api.getProducts({ fresh: true });
    const byVar = new Map<string, { p: Product; v: Variation }>();
    products.forEach((p) => p.variations.forEach((v) => byVar.set(v.id, { p, v })));
    lineNotes = {};
    const left = new Map<string, number>(); // stock not yet claimed by an earlier line
    const lines = readCart().map((l) => {
      const hit = byVar.get(l.variationId);
      const remaining = hit ? (left.get(l.variationId) ?? hit.v.available) : 0;
      if (!hit || remaining === 0) {
        lineNotes[l.key] = "This just sold. Remove it to continue.";
        return { ...l, max: 0 };
      }
      const chosen = chosenModifiers(hit.p, l.modifiers.map((m) => m.id));
      if (!chosen) {
        lineNotes[l.key] = "The options on this have changed. Remove it and add it again.";
        return { ...l, max: 0 };
      }
      const next = {
        ...l, max: hit.v.available,
        modifiers: chosen.map((m) => ({ id: m.id, name: m.name })),
        priceCents: hit.v.priceCents + chosen.reduce((n, m) => n + m.priceCents, 0)
      };
      if (l.qty > remaining) {
        next.qty = remaining;
        lineNotes[l.key] = `Only ${hit.v.available} left, so your quantity was lowered.`;
      }
      left.set(l.variationId, remaining - next.qty);
      return next;
    });
    writeCart(lines);
    // OK to continue as long as every line can still be bought as it stands.
    return lines.every((l) => l.max > 0);
  }

  // The current versions of a line's add-ons, or null if they no longer fit the product's rules.
  function chosenModifiers(p: Product, ids: string[]): Modifier[] | null {
    const all = p.modifierLists.flatMap((l) => l.modifiers);
    if (ids.some((id) => !all.some((m) => m.id === id))) return null;
    const fits = p.modifierLists.every((l) => {
      const n = l.modifiers.filter((m) => ids.includes(m.id)).length;
      return n >= l.min && n <= l.max;
    });
    return fits ? all.filter((m) => ids.includes(m.id)) : null;
  }

  async function startCheckout(btn: HTMLButtonElement) {
    checkoutError = "";
    btn.disabled = true; btn.textContent = "Checking stock…";
    try {
      const ok = await reconcileCart();
      if (!ok) { checkoutError = "Something in your cart is no longer available. Remove it to continue."; renderDrawer(); return; }
      const res = await api.createCheckout({ lines: readCart(), fulfillment: getFulfillment() });
      if (res && res.url) { window.location.href = res.url; return; }
      throw new Error("Checkout link was not returned.");
    } catch (e) {
      const err = e as ApiError;
      const flag = (ids: string[] | undefined, note: string) =>
        readCart().forEach((l) => { if (ids && ids.includes(l.variationId)) lineNotes[l.key] = note; });
      flag(err.body?.soldOut, "This just sold. Remove it to continue.");
      flag(err.body?.changed, "The options on this have changed. Remove it and add it again.");
      checkoutError = err.message || "Checkout couldn't start. Try again in a moment.";
      renderDrawer();
    }
  }

  // ---------- Drawer open/close ----------
  const drawer = () => document.querySelector<HTMLElement>(".drawer")!;
  const backdrop = () => document.querySelector<HTMLElement>(".drawer-backdrop")!;
  let lastFocus: HTMLElement | null = null;
  function openCart() {
    lastFocus = document.activeElement as HTMLElement | null;
    renderDrawer();
    drawer().classList.add("is-open");
    backdrop().classList.add("is-open");
    document.body.style.overflow = "hidden";
    setTimeout(() => drawer().focus(), 30);
  }
  function closeCart() {
    drawer().classList.remove("is-open");
    backdrop().classList.remove("is-open");
    document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  }

  let toastTimer: number | undefined;
  function toast(msg: string) {
    const t = document.querySelector<HTMLElement>("[data-toast]")!;
    t.textContent = msg; t.classList.add("is-on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("is-on"), 2600);
  }

  // ---------- Boot ----------
  function boot() {
    const active = document.body.dataset.page;
    const h = document.querySelector("[data-site-header]");
    const f = document.querySelector("[data-site-footer]");
    if (h) { h.classList.add("site-header"); h.innerHTML = header(active); }
    if (f) { f.classList.add("site-footer"); f.innerHTML = footer(); }
    document.body.insertAdjacentHTML("beforeend", drawerShell());
    renderCount();

    document.addEventListener("click", (e) => {
      const t = (e.target as Element).closest<HTMLElement>("[data-open-cart],[data-close-cart],[data-menu],[data-theme-toggle],[data-inc],[data-dec],[data-remove],[data-checkout]");
      if (!t) return;
      if (t.hasAttribute("data-open-cart")) openCart();
      else if (t.hasAttribute("data-theme-toggle")) toggleTheme();
      else if (t.hasAttribute("data-close-cart")) { if (t.tagName !== "A") e.preventDefault(); closeCart(); }
      else if (t.hasAttribute("data-menu")) {
        const nav = document.getElementById("mobile-nav")!;
        const open = nav.classList.toggle("is-open");
        t.setAttribute("aria-expanded", String(open));
      } else if (t.dataset.inc) {
        const lines = readCart();
        const l = lines.find((x) => x.key === t.dataset.inc);
        if (l && inCart(lines, l.variationId) < l.max) cart.setQty(l.key, l.qty + 1);
      } else if (t.dataset.dec) {
        const l = readCart().find((x) => x.key === t.dataset.dec);
        if (l) cart.setQty(l.key, l.qty - 1);
      } else if (t.dataset.remove) {
        delete lineNotes[t.dataset.remove];
        cart.setQty(t.dataset.remove, 0);
      } else if (t.hasAttribute("data-checkout")) startCheckout(t as HTMLButtonElement);
    });
    document.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name === "fulfil") setFulfillment(input.value);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.querySelector(".drawer.is-open")) closeCart();
    });
    window.addEventListener("storage", (e) => { if (e.key === CART_KEY) { renderCount(); renderDrawer(); } });
  }

  window.GC = { cart, openCart, toast, esc, root };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
