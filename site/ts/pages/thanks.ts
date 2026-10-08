// Thank-you page, where Square sends buyers after they pay.
import * as api from "../api.ts";
import { cart } from "../chrome.ts";

cart.clear();
try {
  sessionStorage.setItem("gc-bought", String(Date.now()));
} catch (_) {
  /* storage unavailable */
}
// What they just bought may now be sold out: drop the saved product list so the shop shows it right away.
api.getProducts({ fresh: true }).catch(() => {});
