// The photo gallery on a product page and on a past commission's page: one big picture with
// arrows over it, and a strip of thumbnails underneath.

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
