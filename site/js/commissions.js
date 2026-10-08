"use strict";
// Commission form. Sends the request to the Worker, which emails it to the shop and
// a confirmation to the client. In demo mode (no Worker) it opens the visitor's email app instead.
(function () {
    const cfg = window.GC_CONFIG;
    const api = window.GC_API;
    const form = document.querySelector("[data-commission]");
    const status = document.querySelector("[data-form-status]");
    if (!form)
        return;
    const button = form.querySelector('button[type="submit"]');
    const field = (name) => form.elements.namedItem(name);
    // Same rule the Worker enforces: one @, no spaces, a dotted domain with a 2+ letter ending.
    const EMAIL_RE = /^[^\s@<>(),;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
    const isEmail = (s) => s.length <= 254 && EMAIL_RE.test(s) && !s.includes("..");
    function say(text, isError = false) {
        status.textContent = text;
        status.style.color = isError ? "var(--danger)" : "";
    }
    function markInvalid(names) {
        ["name", "email", "idea"].forEach((n) => {
            if (names.includes(n))
                field(n).setAttribute("aria-invalid", "true");
            else
                field(n).removeAttribute("aria-invalid");
        });
        if (names.length)
            field(names[0]).focus();
    }
    function openMailApp(data) {
        const body = [
            `Name: ${data.name}`,
            `Email: ${data.email}`,
            `Type: ${data.type}`,
            data.when ? `Needed by: ${data.when}` : "",
            data.budget ? `Budget: ${data.budget}` : "",
            "",
            data.idea,
        ]
            .filter((l) => l !== "")
            .join("\n");
        window.location.href = `mailto:${cfg.contactEmail}?subject=${encodeURIComponent(`Commission request: ${data.type}`)}&body=${encodeURIComponent(body)}`;
        say(`Your email app should open with the request ready to send. If it doesn't, email ${cfg.contactEmail}.`);
    }
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
        const missing = [];
        const invalid = [];
        if (!data.name) {
            missing.push("your name");
            invalid.push("name");
        }
        if (!isEmail(data.email)) {
            missing.push("a valid email");
            invalid.push("email");
        }
        if (!data.idea) {
            missing.push("a description of your idea");
            invalid.push("idea");
        }
        markInvalid(invalid);
        if (missing.length)
            return say(`Add ${missing.join(", ")} to send the request.`, true);
        if (api.isDemo())
            return openMailApp(data);
        button.disabled = true;
        say("Sending…");
        try {
            const res = await api.sendCommission(data);
            form.reset();
            say(res.confirmationSent
                ? `Request sent. A confirmation is on its way to ${data.email}.`
                : `Request sent. The confirmation email to ${data.email} didn't go through, so check the address; I'll still reply there.`);
        }
        catch (e) {
            const err = e;
            const mine = err.status && err.body && err.body.error;
            say(`${mine ? err.message : "The request didn't send."} You can also email ${cfg.contactEmail}.`, true);
        }
        finally {
            button.disabled = false;
        }
    });
})();
