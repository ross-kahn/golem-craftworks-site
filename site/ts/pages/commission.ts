// One past commission (/commissions/<slug>). The Worker writes the whole page; this makes its photos browsable.
import "../chrome.ts";
import { gallery } from "../gallery.ts";

const root = document.querySelector<HTMLElement>(".gallery");
if (root)
  gallery(
    root,
    [...root.querySelectorAll<HTMLElement>("[data-thumb]")].map(
      (b) => b.dataset.full!,
    ),
  );
