"use strict";
// Reviews page: the list (Etsy reviews plus ones left here) and the form to leave one.
(function () {
    const cfg = window.GC_CONFIG;
    const api = window.GC_API;
    const { esc } = window.GC;
    const listEl = document.querySelector("[data-reviews]");
    const summaryEl = document.querySelector("[data-review-summary]");
    const moreBtn = document.querySelector("[data-more-reviews]");
    const etsyNote = document.querySelector("[data-etsy-note]");
    const form = document.querySelector("[data-review-form]");
    const status = document.querySelector("[data-form-status]");
    const button = form.querySelector('button[type="submit"]');
    const PAGE = 12;
    const MAX_PHOTOS = 3;
    const opened = Date.now();
    // ---------- List ----------
    const stars = (n) => `<span class="stars" role="img" aria-label="${n} out of 5 stars">${"★".repeat(n)}<span class="stars__off">${"★".repeat(5 - n)}</span></span>`;
    function card(r) {
        const when = new Date(r.at).toLocaleDateString("en-US", { year: "numeric", month: "long" });
        const from = r.source === "etsy" ? "Etsy buyer" : r.name;
        return `
      <li class="review">
        <p class="review__head">${stars(r.rating)}</p>
        ${r.text ? `<p class="review__text">${esc(r.text)}</p>` : ""}
        ${r.photos.length ? `<div class="review__photos">${r.photos.map((src) => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="Photo from this review" loading="lazy"></a>`).join("")}</div>` : ""}
        <p class="review__by">${esc(from)}${r.product ? ` · ${esc(r.product)}` : ""} · ${esc(when)}${r.source === "etsy" ? " · on Etsy" : ""}</p>
      </li>`;
    }
    let reviews = [];
    let shown = PAGE;
    function render() {
        listEl.innerHTML = reviews.length
            ? reviews.slice(0, shown).map(card).join("")
            : `<li class="empty">No reviews here yet. Yours could be the first.</li>`;
        moreBtn.hidden = shown >= reviews.length;
    }
    moreBtn.addEventListener("click", () => { shown += PAGE; render(); });
    api.getReviews().then((data) => {
        reviews = data.reviews;
        const s = data.stats;
        const parts = [
            s.average !== null ? `${stars(Math.round(s.average))} ${s.average.toFixed(1)} from ${s.count.toLocaleString("en-US")} ${s.count === 1 ? "review" : "reviews"}` : "",
            s.sales != null ? `${s.sales.toLocaleString("en-US")} sales` : ""
        ].filter(Boolean);
        summaryEl.innerHTML = parts.join(" · ");
        summaryEl.hidden = !parts.length;
        etsyNote.hidden = !reviews.some((r) => r.source === "etsy");
        render();
    }).catch(() => {
        listEl.innerHTML = `<li class="empty">Reviews couldn't load right now. Refresh to try again.</li>`;
    });
    // ---------- Form ----------
    function say(text, isError = false) {
        status.textContent = text;
        status.style.color = isError ? "var(--danger)" : "";
    }
    // Shrinks a photo in the browser before it's sent. This also drops the location data cameras embed.
    async function shrink(file) {
        try {
            const img = await createImageBitmap(file);
            const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
            return blob || file;
        }
        catch (_) {
            return file; // the Worker checks whatever arrives
        }
    }
    // Cloudflare's spam check, only when a site key is set in config.ts.
    if (cfg.turnstileSiteKey) {
        document.querySelector("[data-turnstile]").innerHTML = `<div class="cf-turnstile" data-sitekey="${esc(cfg.turnstileSiteKey)}"></div>`;
        const s = document.createElement("script");
        s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        s.async = true;
        document.head.appendChild(s);
    }
    const EMAIL_RE = /^[^\s@<>(),;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const data = new FormData(form);
        const text = (name) => String(data.get(name) || "").trim();
        const files = data.getAll("photos").filter((f) => f instanceof File && f.size > 0);
        const missing = [];
        if (!text("name"))
            missing.push("your name");
        if (!EMAIL_RE.test(text("email")))
            missing.push("a valid email");
        if (!text("rating"))
            missing.push("a star rating");
        if (!text("text"))
            missing.push("a few words about it");
        if (missing.length)
            return say(`Add ${missing.join(", ")} to send your review.`, true);
        if (files.length > MAX_PHOTOS)
            return say(`Add up to ${MAX_PHOTOS} photos.`, true);
        if (api.isDemo())
            return say("Reviews are turned off in demo mode.", true);
        button.disabled = true;
        say(files.length ? "Preparing photos…" : "Sending…");
        try {
            data.delete("photos");
            for (const f of files)
                data.append("photos", await shrink(f), "photo.jpg");
            data.set("elapsed", String(Date.now() - opened));
            say("Sending…");
            const sent = await api.sendReview(data);
            form.reset();
            if (sent.review) {
                reviews.unshift(sent.review);
                render();
            }
            say(sent.review ? "Thank you! Your review is posted." : "Thank you! Your review is in.");
        }
        catch (e) {
            const err = e;
            say(err.status && err.body && err.body.error ? err.message : "Your review didn't send. Try again in a moment.", true);
        }
        finally {
            button.disabled = false;
        }
    });
})();
