// The photo gallery on a product page and on a past commission's page: one big picture with
// arrows over it, and a strip of thumbnails underneath. Also the smaller version on the shop's
// product cards: arrows, a swipe on a phone, and dots for which photo is showing.

import { esc } from "../../shared/text.ts";

const chevron = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

// The previous and next buttons that go over a photo. On a grid, `of` names the piece, so a screen reader can tell the cards' buttons apart.
export function arrows(of?: string) {
  const label = (which: string) =>
    esc(of ? `${which} photo of ${of}` : `${which} photo`);
  return `<button class="gallery__nav gallery__nav--prev" type="button" data-step="-1" aria-label="${label("Previous")}">${chevron("M15 5l-7 7 7 7")}</button>
          <button class="gallery__nav gallery__nav--next" type="button" data-step="1" aria-label="${label("Next")}">${chevron("M9 5l7 7-7 7")}</button>`;
}

// Makes the arrows and thumbnails inside `root` work. `images` are the full-size photos, in the strip's order.
export function gallery(root: HTMLElement, images: string[]) {
  let shown = 0;
  function show(i: number) {
    shown = i;
    root.querySelector<HTMLImageElement>("[data-main]")!.src = images[i];
    root.querySelectorAll<HTMLElement>("[data-thumb]").forEach((b) => {
      const on = Number(b.dataset.thumb) === i;
      b.setAttribute("aria-current", String(on));
      // Keeps the strip following along when the arrows move past its edge.
      if (on) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }
  root.addEventListener("click", (e) => {
    const target = e.target as Element;
    const thumb = target.closest<HTMLElement>("[data-thumb]");
    if (thumb) show(Number(thumb.dataset.thumb));
    const step = target.closest<HTMLElement>("[data-step]");
    // Stepping past either end wraps around to the other.
    if (step)
      show((shown + Number(step.dataset.step) + images.length) % images.length);
  });
}

// Makes the photos step on every product card in `grid`, including cards drawn into it later.
// A card's photos are listed in its data-photos. Only the one showing is downloaded, and the next
// one once the visitor points at or touches the card, so a grid loads no more than one photo a card.
export function cardPhotos(grid: HTMLElement) {
  const mediaOf = (target: EventTarget | null) =>
    (target as Element | null)?.closest<HTMLElement>("[data-photos]");
  const photosOf = (media: HTMLElement): string[] =>
    JSON.parse(media.dataset.photos!);
  const shownOf = (media: HTMLElement) => Number(media.dataset.shown || 0);
  const preload = (src: string) => {
    new Image().src = src;
  };
  function warm(media: HTMLElement) {
    if (media.dataset.warm) return;
    media.dataset.warm = "1";
    preload(photosOf(media)[1]);
  }
  // Stepping past either end wraps around to the other.
  function step(media: HTMLElement, by: number) {
    const photos = photosOf(media);
    const i = (shownOf(media) + by + photos.length) % photos.length;
    media.dataset.shown = String(i);
    media.querySelector<HTMLImageElement>("[data-main]")!.src = photos[i];
    media.querySelectorAll("[data-dot]").forEach((dot, j) => {
      dot.setAttribute("aria-current", String(j === i));
    });
    preload(photos[(i + by + photos.length) % photos.length]);
  }

  grid.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-step]");
    const media = button && mediaOf(button);
    if (media) step(media, Number(button.dataset.step));
  });
  // Fetch the next photo when the visitor points at, tabs to, or touches the card, so the first step is instant.
  for (const type of ["pointerover", "focusin"])
    grid.addEventListener(type, (e) => {
      const media = mediaOf(e.target);
      if (media) warm(media);
    });
  // A sideways swipe on a photo steps it; anything more up-and-down is left as a scroll.
  let start: { x: number; y: number } | null = null;
  grid.addEventListener(
    "touchstart",
    (e) => {
      const media = mediaOf(e.target);
      if (!media) return;
      warm(media);
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    },
    { passive: true },
  );
  grid.addEventListener("touchend", (e) => {
    const media = mediaOf(e.target);
    if (!media || !start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy))
      step(media, dx < 0 ? 1 : -1);
  });
}
