"use strict";
// Shared page chrome (header, footer, cart drawer) and the cart itself.
(function () {
    const cfg = window.GC_CONFIG;
    const api = window.GC_API;
    const root = api.siteRoot();
    const CART_KEY = "gc-cart-v1";
    const FULFIL_KEY = "gc-fulfillment";
    const icons = {
        bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 8h14l-1 13H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>',
        menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h18M3 12h18M3 17h18"/></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    };
    const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
    // ---------- Cart store ----------
    let memoryCart = [];
    function readCart() {
        try {
            return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
        }
        catch (_) {
            return memoryCart;
        }
    }
    function writeCart(lines) {
        memoryCart = lines;
        try {
            localStorage.setItem(CART_KEY, JSON.stringify(lines));
        }
        catch (_) { }
        renderCount();
        renderDrawer();
    }
    function getFulfillment() {
        try {
            return (localStorage.getItem(FULFIL_KEY) || "ship");
        }
        catch (_) {
            return "ship";
        }
    }
    function setFulfillment(v) { try {
        localStorage.setItem(FULFIL_KEY, v);
    }
    catch (_) { } renderDrawer(); }
    const cart = {
        lines: readCart,
        count: () => readCart().reduce((n, l) => n + l.qty, 0),
        add(product, variation, qty = 1) {
            const lines = readCart();
            const existing = lines.find((l) => l.variationId === variation.id);
            const max = variation.available;
            if (existing) {
                if (existing.qty >= max)
                    return { ok: false, reason: max === 1 ? "That piece is already in your cart." : `Only ${max} available.` };
                existing.qty = Math.min(max, existing.qty + qty);
                existing.max = max;
            }
            else {
                lines.push({
                    variationId: variation.id,
                    productId: product.id,
                    name: product.name,
                    variationName: product.variations.length > 1 ? variation.name : "",
                    priceCents: variation.priceCents,
                    image: (product.images && product.images[0]) || "",
                    qty: Math.min(qty, max),
                    max
                });
            }
            writeCart(lines);
            return { ok: true };
        },
        setQty(variationId, qty) {
            let lines = readCart();
            lines = lines.map((l) => (l.variationId === variationId ? { ...l, qty } : l)).filter((l) => l.qty > 0);
            writeCart(lines);
        },
        clear() { writeCart([]); }
    };
    // ---------- Chrome ----------
    function header(active) {
        const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
        const links = [
            link(root, "Shop", "shop"),
            link(root + "commissions/", "Commissions", "commissions"),
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
        <button class="cart-btn" type="button" data-open-cart aria-haspopup="dialog">
          ${icons.bag}<span class="visually-hidden">Cart,</span>
          <span class="cart-btn__count" data-cart-count data-empty="true">0</span>
          <span class="visually-hidden">items</span>
        </button>
        <button class="menu-btn" type="button" aria-expanded="false" aria-controls="mobile-nav" data-menu>
          ${icons.menu}<span class="visually-hidden">Menu</span>
        </button>
      </div>
      <nav class="mobile-nav" id="mobile-nav" aria-label="Main">${links}</nav>`;
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
        document.querySelectorAll("[data-cart-count]").forEach((el) => {
            el.textContent = String(n);
            el.dataset.empty = n === 0 ? "true" : "false";
        });
    }
    let checkoutError = "";
    let lineNotes = {};
    function renderDrawer() {
        const body = document.querySelector("[data-drawer-body]");
        const foot = document.querySelector("[data-drawer-foot]");
        if (!body || !foot)
            return;
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
            const note = lineNotes[l.variationId];
            return `
      <div class="line">
        <div class="line__img">${l.image ? `<img src="${esc(l.image)}" alt="">` : `<div class="ph"><img src="${root}assets/logo.png" alt=""></div>`}</div>
        <div>
          <p class="line__name">${esc(l.name)}</p>
          ${l.variationName ? `<p class="line__variant">${esc(l.variationName)}</p>` : `<p class="line__variant"></p>`}
          ${l.max === 1
                ? `<button class="text-btn" type="button" data-remove="${esc(l.variationId)}">Remove</button>`
                : `<div class="qty" role="group" aria-label="Quantity for ${esc(l.name)}">
                 <button type="button" data-dec="${esc(l.variationId)}" aria-label="Decrease">−</button>
                 <output>${l.qty}</output>
                 <button type="button" data-inc="${esc(l.variationId)}" aria-label="Increase" ${l.qty >= l.max ? "disabled" : ""}>+</button>
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
        const byVar = new Map();
        products.forEach((p) => p.variations.forEach((v) => byVar.set(v.id, { p, v })));
        lineNotes = {};
        let changed = false;
        const lines = readCart().map((l) => {
            const hit = byVar.get(l.variationId);
            if (!hit || hit.v.available === 0) {
                lineNotes[l.variationId] = "This just sold. Remove it to continue.";
                changed = true;
                return { ...l, max: 0 };
            }
            const next = { ...l, max: hit.v.available, priceCents: hit.v.priceCents };
            if (l.qty > hit.v.available) {
                next.qty = hit.v.available;
                lineNotes[l.variationId] = `Only ${hit.v.available} left, so your quantity was lowered.`;
                changed = true;
            }
            if (l.priceCents !== hit.v.priceCents)
                changed = true;
            return next;
        });
        writeCart(lines);
        // OK to continue as long as nothing in the cart is fully sold out.
        return lines.every((l) => l.max > 0);
    }
    async function startCheckout(btn) {
        checkoutError = "";
        btn.disabled = true;
        btn.textContent = "Checking stock…";
        try {
            const ok = await reconcileCart();
            if (!ok) {
                checkoutError = "Something in your cart sold out. Remove it to continue.";
                renderDrawer();
                return;
            }
            const res = await api.createCheckout({ lines: readCart(), fulfillment: getFulfillment() });
            if (res && res.url) {
                window.location.href = res.url;
                return;
            }
            throw new Error("Checkout link was not returned.");
        }
        catch (e) {
            const err = e;
            if (err.body && err.body.soldOut) {
                err.body.soldOut.forEach((id) => { lineNotes[id] = "This just sold. Remove it to continue."; });
            }
            checkoutError = err.message || "Checkout couldn't start. Try again in a moment.";
            renderDrawer();
        }
    }
    // ---------- Drawer open/close ----------
    const drawer = () => document.querySelector(".drawer");
    const backdrop = () => document.querySelector(".drawer-backdrop");
    let lastFocus = null;
    function openCart() {
        lastFocus = document.activeElement;
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
        if (lastFocus)
            lastFocus.focus();
    }
    let toastTimer;
    function toast(msg) {
        const t = document.querySelector("[data-toast]");
        t.textContent = msg;
        t.classList.add("is-on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove("is-on"), 2600);
    }
    // ---------- Boot ----------
    function boot() {
        const active = document.body.dataset.page;
        const h = document.querySelector("[data-site-header]");
        const f = document.querySelector("[data-site-footer]");
        if (h) {
            h.classList.add("site-header");
            h.innerHTML = header(active);
        }
        if (f) {
            f.classList.add("site-footer");
            f.innerHTML = footer();
        }
        document.body.insertAdjacentHTML("beforeend", drawerShell());
        renderCount();
        document.addEventListener("click", (e) => {
            const t = e.target.closest("[data-open-cart],[data-close-cart],[data-menu],[data-inc],[data-dec],[data-remove],[data-checkout]");
            if (!t)
                return;
            if (t.hasAttribute("data-open-cart"))
                openCart();
            else if (t.hasAttribute("data-close-cart")) {
                if (t.tagName !== "A")
                    e.preventDefault();
                closeCart();
            }
            else if (t.hasAttribute("data-menu")) {
                const nav = document.getElementById("mobile-nav");
                const open = nav.classList.toggle("is-open");
                t.setAttribute("aria-expanded", String(open));
            }
            else if (t.dataset.inc) {
                const l = readCart().find((x) => x.variationId === t.dataset.inc);
                if (l && l.qty < l.max)
                    cart.setQty(l.variationId, l.qty + 1);
            }
            else if (t.dataset.dec) {
                const l = readCart().find((x) => x.variationId === t.dataset.dec);
                if (l)
                    cart.setQty(l.variationId, l.qty - 1);
            }
            else if (t.dataset.remove) {
                delete lineNotes[t.dataset.remove];
                cart.setQty(t.dataset.remove, 0);
            }
            else if (t.hasAttribute("data-checkout"))
                startCheckout(t);
        });
        document.addEventListener("change", (e) => {
            const input = e.target;
            if (input.name === "fulfil")
                setFulfillment(input.value);
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && document.querySelector(".drawer.is-open"))
                closeCart();
        });
        window.addEventListener("storage", (e) => { if (e.key === CART_KEY) {
            renderCount();
            renderDrawer();
        } });
    }
    window.GC = { cart, openCart, toast, esc, root };
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", boot);
    else
        boot();
})();
