// Commission form. Sends the request to the Worker, which emails it to the shop and
// a confirmation to the client.
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
