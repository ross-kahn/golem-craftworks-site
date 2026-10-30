// Product page: gallery, option picker, add to cart.
import * as api from "../api.ts";
import { cart, openCart, toast } from "../chrome.ts";
import { arrows, gallery } from "../gallery.ts";
import { max } from "radashi";
import { esc } from "../../../shared/text.ts";
import {
  leadingMatch,
  optionOpen,
  settlePicks,
} from "../../../shared/catalog.ts";

const mount = document.querySelector<HTMLElement>("[data-product]")!;
// The page's address is /product/<slug>.
const slug = decodeURIComponent(location.pathname.split("/product/")[1] || "");

function notFound() {
  document.title = "Not found · Golem Craftworks";
  mount.innerHTML = `
    <div class="thanks">
      <h1>That piece isn't here.</h1>
      <p>It may have sold or been taken down. Everything available is in the shop.</p>
      <a class="btn" href="/">Browse the shop</a>
    </div>`;
}

function stockText(p: Product, v: Variation) {
  if (v.available === 0) return { text: "Sold", cls: "" };
  if (p.unique)
    return {
      text: "One of a kind. When it's gone, it's gone.",
      cls: "product__stock--unique",
    };
  if (v.qty === null || v.qty === undefined)
    return { text: "Made to order", cls: "" };
  if (v.available <= 3) return { text: `${v.available} left`, cls: "" };
  return { text: "In stock", cls: "" };
}

// The nudge toward commissions, worded for what's on the page.
function customPrompt(p: Product) {
  const category = (p.category || "").toLowerCase();
  if (/\b(dice|die)\b/.test(category))
    return "Want a set in colors of your own?";
  if (/wood/.test(category))
    return "Want it engraved or made with a different wood?";
  return "Want something made just for you?";
}

// What Square's min/max rules mean for the buyer, when it isn't obvious from the options.
function listHint(l: ModifierList) {
  if (l.modifiers.length === 1) return l.min ? "" : "Optional";
  if (l.min === l.max) return `Choose ${l.min}`;
  if (l.min === 0)
    return l.max === l.modifiers.length
      ? "Optional"
      : `Optional, up to ${l.max}`;
  return l.max === l.modifiers.length
    ? `Choose at least ${l.min}`
    : `Choose ${l.min} to ${l.max}`;
}

// Square's item options ("Wood", "Design"), when every variation is one combination of them: a choice for each.
const optionsOf = (p: Product) =>
  p.options?.length &&
  p.variations.every((v) => v.choices?.length === p.options!.length)
    ? p.options
    : null;

// One choice per option. Which values are picked, and which can be, is set by syncOptions.
const optionPickers = (options: ProductOption[]) =>
  options
    .map(
      (o, i) => `
          <fieldset class="picker">
            <legend>${esc(o.name)}</legend>
            <div class="picker__options">
              ${o.values
                .map(
                  (value) => `
                <label class="picker__option">
                  <input type="radio" name="option-${i}" value="${esc(value)}">
                  <span>${esc(value)}</span><small class="visually-hidden" data-note></small>
                </label>`,
                )
                .join("")}
            </div>
          </fieldset>`,
    )
    .join("");

function render(p: Product) {
  document.title = `${p.name} · Golem Craftworks`;
  const options = optionsOf(p);
  const combos = p.variations.map((v) => ({
    choices: v.choices || [],
    inStock: v.available > 0,
  }));
  // The piece for some picks, or when that one isn't made, the one sharing the most of the first picks.
  const pieceFor = (picks: string[]) =>
    max(
      p.variations,
      (v) => leadingMatch(v.choices!, picks) * 2 + Number(v.available > 0),
    )!;
  const firstPicks = options ? settlePicks(options, combos, [], -1) : [];
  const firstAvail = options
    ? pieceFor(firstPicks)
    : p.variations.find((v) => v.available > 0) || p.variations[0];
  const images = p.images && p.images.length ? p.images : [];
  const multi = p.variations.length > 1;

  mount.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Shop</a> / <a href="${esc(api.categoryLink(p.category))}">${esc(p.category)}</a>
    </nav>
    <div class="product">
      <div class="gallery">
        <div class="gallery__main">
          ${images.length ? `<img src="${esc(images[0])}" alt="${esc(p.name)}" data-main>` : `<div class="ph"><img src="/assets/logo.png" alt=""></div>`}
          ${
            images.length > 1 ? arrows() : ""
          }
        </div>
        ${
          images.length > 1
            ? `<div class="gallery__thumbs">${images
                .map(
                  (src, i) =>
                    `<button type="button" data-thumb="${i}" aria-current="${i === 0}" aria-label="Photo ${i + 1} of ${images.length}"><img src="${esc(src)}" alt="" loading="lazy"></button>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="product__info">
        <h1>${esc(p.name)}</h1>
        <p class="product__price" data-price>${api.money(firstAvail.priceCents)}</p>
        <p class="product__stock" data-stock></p>
        ${
          options
            ? optionPickers(options)
            : multi
            ? `
          <fieldset class="picker">
            <legend>${esc(p.optionLabel || "Option")}</legend>
            <div class="picker__options">
              ${p.variations
                .map(
                  (v) => `
                <label class="picker__option">
                  <input type="radio" name="variation" value="${esc(v.id)}" ${v.id === firstAvail.id ? "checked" : ""} ${v.available === 0 ? "disabled" : ""}>
                  <span>${esc(v.name)}${v.available === 0 ? " (sold out)" : ""}</span>
                </label>`,
                )
                .join("")}
            </div>
          </fieldset>`
            : ""
        }
        ${p.modifierLists
          .map(
            (l) => `
          <fieldset class="picker" data-list="${esc(l.id)}">
            <legend>${esc(l.name)}${listHint(l) ? ` <small class="picker__hint">${listHint(l)}</small>` : ""}</legend>
            <div class="picker__options">
              ${l.modifiers
                .map(
                  (m) => `
                <label class="picker__option">
                  <input type="${l.min === 1 && l.max === 1 ? "radio" : "checkbox"}" name="mod-${esc(l.id)}" value="${esc(m.id)}" ${m.default ? "checked" : ""}>
                  <span>${esc(m.name)}${m.priceCents ? ` (${m.priceCents > 0 ? "+" : "−"}${api.money(Math.abs(m.priceCents))})` : ""}</span>
                </label>`,
                )
                .join("")}
            </div>
          </fieldset>`,
          )
          .join("")}
        <div class="product__buy">
          <button class="btn btn--block" type="button" data-add>Add to cart</button>
        </div>
        <div class="product__desc">
          ${(p.description || "")
            .split(/\n{2,}/)
            .map((para) => `<p>${esc(para)}</p>`)
            .join("")}
        </div>
        <div class="product__aside">
          <p><strong class="lead-in">Shipping or pickup.</strong> Ships in the US for a flat ${api.money(window.GC_CONFIG.shippingCents)}, or pick up in Madison for free.</p>
          <p>${customPrompt(p)} <a href="/commissions/">Start a commission</a>.</p>
        </div>
      </div>
    </div>`;

  let current = firstAvail;
  const priceEl = mount.querySelector<HTMLElement>("[data-price]")!;
  const stockEl = mount.querySelector<HTMLElement>("[data-stock]")!;
  const addBtn = mount.querySelector<HTMLButtonElement>("[data-add]")!;

  const checked = (l: ModifierList) =>
    [
      ...mount.querySelectorAll<HTMLInputElement>(
        `[name="mod-${CSS.escape(l.id)}"]:checked`,
      ),
    ].map((i) => i.value);
  const selected = () =>
    p.modifierLists.flatMap((l) =>
      l.modifiers.filter((m) => checked(l).includes(m.id)),
    );

  function update() {
    const s = stockText(p, current);
    const mods = selected();
    priceEl.textContent = api.money(
      current.priceCents + mods.reduce((n, m) => n + m.priceCents, 0),
    );
    stockEl.textContent = s.text;
    stockEl.className = "product__stock " + s.cls;
    const inCart = cart.inCart(current.id);
    const short = p.modifierLists.find((l) => checked(l).length < l.min);
    delete addBtn.dataset.view;
    if (current.available === 0) {
      addBtn.disabled = true;
      addBtn.textContent = "Sold";
    } else if (inCart >= current.available) {
      addBtn.disabled = false;
      addBtn.textContent = "In your cart · view cart";
      addBtn.dataset.view = "1";
    } else if (short) {
      addBtn.disabled = true;
      addBtn.textContent = `Choose ${short.name.toLowerCase()} to continue`;
    } else {
      addBtn.disabled = false;
      addBtn.textContent = "Add to cart";
    }
  }

  const showPhoto = gallery(
    mount.querySelector<HTMLElement>(".gallery")!,
    images,
  );

  const optionInputs = (i: number) => [
    ...mount.querySelectorAll<HTMLInputElement>(`[name="option-${i}"]`),
  ];
  // Ticks the picks and crosses out what can't be had: a first-option value with nothing left at all,
  // or a later one with nothing left alongside the picks ahead of it.
  function syncOptions(picks: string[]) {
    options?.forEach((_, i) =>
      optionInputs(i).forEach((input) => {
        const open = optionOpen(combos, picks, i, input.value);
        input.checked = input.value === picks[i];
        input.disabled = !open;
        input.nextElementSibling!.textContent =
          input.value + (!open && i === 0 ? " (sold out)" : "");
        input.parentElement!.querySelector("[data-note]")!.textContent =
          !open && i > 0
            ? ` (not available in ${picks.slice(0, i).join(", ")})`
            : "";
      }),
    );
  }
  function choose(v: Variation) {
    current = v;
    const photo = images.indexOf(v.image ?? "");
    if (photo >= 0) showPhoto(photo);
    update();
  }

  mount.addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.name === "variation")
      choose(p.variations.find((v) => v.id === input.value) || current);
    const option = /^option-(\d+)$/.exec(input.name);
    if (option) {
      const i = Number(option[1]);
      const picks = options!.map(
        (_, j) => optionInputs(j).find((x) => x.checked)?.value ?? "",
      );
      const settled = settlePicks(options!, combos, picks, i);
      syncOptions(settled);
      choose(pieceFor(settled));
    }
    const list = p.modifierLists.find((l) => input.name === `mod-${l.id}`);
    if (list) {
      // Past the limit: with one choice allowed the new pick replaces the old one, otherwise it's refused.
      const over = checked(list).length > list.max;
      if (over && list.max === 1) {
        mount
          .querySelectorAll<HTMLInputElement>(
            `[name="${CSS.escape(input.name)}"]`,
          )
          .forEach((i) => {
            i.checked = i === input;
          });
      } else if (over) {
        input.checked = false;
        toast(`Choose up to ${list.max}.`);
      }
      update();
    }
  });
  mount.addEventListener("click", (e) => {
    const target = e.target as Element;
    if (target.closest("[data-add]")) {
      if (addBtn.dataset.view) {
        openCart();
        return;
      }
      const r = cart.add(p, current, 1, selected());
      if (r.ok) {
        toast(`Added ${p.name} to your cart`);
        update();
      } else toast(r.reason);
    }
  });
  syncOptions(firstPicks);
  update();
}

api
  .getProduct(slug)
  .then((p) => (p ? render(p) : notFound()))
  .catch(() => {
    mount.innerHTML = `<div class="thanks"><h1>This page couldn't load.</h1><p>Refresh to try again.</p></div>`;
  });
