// Commission form. Sends the request to the Worker, which emails it to the shop and
// a confirmation to the client. The past commissions above it are written into the page by the Worker.
import * as api from "../api.ts";
import { formStatus } from "../chrome.ts";
import { check } from "../../../shared/validate.ts";
import { Commission } from "../../../shared/forms.ts";

const cfg = window.GC_CONFIG;
const form = document.querySelector<HTMLFormElement>("[data-commission]")!;
const status = document.querySelector<HTMLElement>("[data-form-status]")!;
const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const field = (name: string) => form.elements.namedItem(name) as HTMLElement;
const say = formStatus(status);

function markInvalid(names: string[]) {
  ["name", "email", "idea"].forEach((n) => {
    if (names.includes(n)) field(n).setAttribute("aria-invalid", "true");
    else field(n).removeAttribute("aria-invalid");
  });
  if (names.length) field(names[0]).focus();
}

// Arriving from "Start a commission like this" on a past commission's page (?like=<its slug>):
// the form opens on that kind of piece, with the idea started.
const like = new URLSearchParams(location.search).get("like");
const piece = [...document.querySelectorAll<HTMLElement>("[data-piece]")].find(
  (el) => el.dataset.piece === like,
);
if (piece) {
  const type = field("type") as unknown as HTMLSelectElement;
  if ([...type.options].some((o) => o.value === piece.dataset.type))
    type.value = piece.dataset.type!;
  (field("idea") as HTMLTextAreaElement).value =
    `I'd like something like "${piece.dataset.name}". `;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const typed = Object.fromEntries(
    [...new FormData(form)].map(([k, v]) => [k, String(v)]),
  );

  // The same check the Worker makes when the request arrives.
  const { data, missing, fields } = check(Commission, typed);
  markInvalid(fields);
  if (missing.length)
    return say(`Add ${missing.join(", ")} to send the request.`, true);

  button.disabled = true;
  say("Sending…");
  try {
    const res = await api.sendCommission(typed);
    form.reset();
    say(
      res.confirmationSent
        ? `Request sent. A confirmation is on its way to ${data.email}.`
        : `Request sent. The confirmation email to ${data.email} didn't go through, so check the address; I'll still reply there.`,
    );
  } catch (e) {
    const err = e as ApiError;
    const mine = err.status && err.body && err.body.error;
    say(
      `${mine ? err.message : "The request didn't send."} You can also email ${cfg.contactEmail}.`,
      true,
    );
  } finally {
    button.disabled = false;
  }
});
