# Golem Craftworks website

A storefront for golemcraftworks.com that sells straight from your Square inventory and keeps Etsy in step with Square.

The whole thing runs on Cloudflare's free plan as one Worker: Cloudflare serves the pages in `site/`, and the Worker code handles checkout, the commission form and the Square/Etsy sync. GitHub holds the source in a private repo and plays no part in hosting.

**Before launch the shop lives at `https://preview.golemcraftworks.com`**, hidden from search engines, while `golemcraftworks.com` still shows the old link page. Every address in the setup steps below uses the preview address. [Going public](#going-public) lists what to change when the shop is ready for the main address.

```
site/      The website: pages and styles as they are, scripts bundled from ts/.
  index.html            Shop (home): one tile per category
  shop/                 Category page (/shop/<category>)
  product/              Product page  (/product/<name>)
  about/  commissions/  reviews/  shipping/  thanks/   Content pages
  styles/main.css       All styling
  ts/pages/             One script per page, plus config.ts (the shop's settings) and theme.ts
  ts/                   What the pages share: api.ts (talking to the Worker), chrome.ts (header, footer, cart)
  js/                   Built from ts/ by `npm run build`. Not in git; don't edit by hand.
  assets/               Logo, favicon, hero golem
  .assetsignore         Files in site/ that are not published (the TypeScript source)
worker/    Cloudflare Worker in TypeScript (Square + Etsy logic, keeps your API keys secret)
  wrangler.toml         Cloudflare settings: domain, site folder, shop options
  src/demo-products.json   Sample products for `npm run dev` and the tests
shared/    Code the site, the Worker and the tools all use (form rules, text helpers, category order)
tools/     One-time helpers that brought the Etsy listings and photos into Square
```

## Build and deploy

Needs Node 22.18 or newer. Run these from the project folder.

```bash
npm install          # once per computer
npx wrangler login   # once per computer: opens Cloudflare in your browser
npm run deploy       # bundles site/ts -> site/js, then publishes the site and the Worker together
```

`npm run deploy` is the only way anything goes live. It publishes whatever is in the folder on your computer, committed or not. Pushing to GitHub does not deploy.

A normal change looks like this:

```bash
npm run dev          # the site and the Worker at http://localhost:8787, rebuilt as you edit
npm run typecheck    # type-check the site, the Worker, shared/ and tools/
npm test             # builds the site, then runs every test
git commit
git push
npm run deploy
```

- **What needs a deploy:** any change to `site/`, `worker/src/` or `worker/wrangler.toml`. Secrets set with `wrangler secret put` take effect at once and need no deploy.
- **`npm run dev` with sample products:** with no Square token set, `npm run dev` shows the sample products in `worker/src/demo-products.json` (dice sets and woodworks, with coloured squares for photos). Checkout doesn't work there.
- **`npm run dev` with real data:** put the secrets in `worker/.dev.vars`, one `NAME=value` per line. Git ignores that file. Use sandbox Square credentials there.
- **Undo a bad deploy:** `npx wrangler rollback` from `worker/` goes back to the previous version.

### Tests

`npm test` covers three things, none of which touch a real account:

- **The Worker** against fake Square, Etsy and Resend (`worker/test/sync.test.ts`, `reviews.test.ts`, `commission.test.ts`, `util.test.ts`).
- **The whole shop in a pretend browser** (`worker/test/site.test.ts`): the Worker serves the real pages and scripts with the sample products, and the test clicks through them: browsing, the cart, checkout, both forms, the theme switch. It only knows what a visitor sees, so it keeps passing however the scripts are rearranged, and fails if a page stops working.
- **The shared helpers and the import tools** (`shared/test/`, `tools/test/`).

### Libraries and shared helpers

The site's scripts are bundled with [esbuild](https://esbuild.github.io), so the site, the Worker and the tools can all import the same code. Two small libraries do the everyday work: [Radashi](https://radashi.js.org) for lists and objects (`sum`, `unique`, `group`, `cluster`, ...) and [Valibot](https://valibot.dev) for checking what visitors type into the forms. Before writing a helper, look for it there, then in these files:

| File | What's in it |
|---|---|
| `shared/forms.ts` | The commission and review forms as Valibot schemas. The page checks against them before sending and the Worker checks again, so both give the same message |
| `shared/validate.ts` | The building blocks for those (`line`, `paragraph`, `emailAddress`) and `check`, which says what's missing |
| `shared/text.ts` | Text: `slugify`, `esc`, `csvList`, `htmlToText`, `decodeEntities` |
| `shared/catalog.ts` | The order categories are shown in, and which photos go on a category's tile |
| `shared/paged.ts` | Reading every page of a long Square list |
| `worker/src/util.ts` | Replies, the activity log, signatures, the admin check and admin page, `claim` and `overLimit` (one-at-a-time and rate limits) |
| `worker/src/email.ts` | Sending through Resend |
| `site/ts/api.ts`, `site/ts/chrome.ts` | What the pages share: fetching and prices; the cart, form status lines, and what a product grid shows while loading or when it can't |
| `tools/shared.ts` | Reading Etsy's CSV export and calling Square from the tools |

Styling goes in `site/styles/main.css` as classes, not in `style="..."` on the page or `.style` in a script.

## How inventory stays in sync

Square is the single source of truth. You only ever change stock in Square.

| What happens | Who updates what |
|---|---|
| Sale at a market (Square POS) | Square lowers stock → Square tells the Worker → Worker updates the Etsy listing |
| Sale on the website | The website checks out through Square, so Square lowers stock automatically → same path to Etsy |
| Sale on Etsy | Etsy tells the Worker → Worker records the sale in Square |
| You edit stock in Square (restock, new piece) | Same path to Etsy: the count goes up or down to match. |
| Every hour | A check catches any Etsy sale whose notification was missed and records it in Square, then sets every Etsy count that differs to match Square. |
| Something sells out | The Etsy listing goes off sale. **The sync never puts a listing back on sale.** After a restock in Square, publish it yourself on Etsy (Shop Manager → Listings → Inactive or Sold out). |

| A new dice set is added in Square | Within a minute or so the Worker makes an Etsy **draft** for it, for you to review and publish. See [New dice sets on Etsy](#new-dice-sets-on-etsy). |

Products are matched between Square and Etsy **by SKU**. That's the one bit of setup that matters most.

Apart from those dice drafts, the sync only changes stock counts on listings that already exist on both sides. It never creates a listing for anything else.

Restocked pieces waiting to be published on Etsy are listed under `notPublished` in `/admin/status`. A listing the sync turned off keeps its count up to date while it waits. One that Etsy itself marked **Sold out** is left untouched, because writing stock to it could relist it and charge the listing fee; once you publish it, the next check sets its count.

## First-time setup

Do these in order. Steps 1 to 4 put the shop online at the preview address; 5 and 6 connect Etsy. [Going public](#going-public) comes after all six.

### 1. SKUs

1. In Square, give every item variation a SKU. One-of-a-kind dice each get their own (for example `DICE-0412`). Standard items get one per option (`YZ-WAL`, `YZ-CHE`, `TWR-BLK`).
2. In Etsy, put the same SKU on the matching listing. For listings with variations (wood species, colors), each variation's SKU must match the Square variation's SKU.
3. In Square, turn on stock tracking for anything you want synced. Items without tracking show as "Made to order" on the site and are never touched on Etsy.

After setup, `/admin/status` lists any SKUs found on only one side so you can fix gaps.

### 2. Move the domain to Cloudflare

The Worker can only be attached to a domain that Cloudflare manages, so the domain's DNS moves from GoDaddy to Cloudflare. The domain stays registered at GoDaddy.

1. Create a free Cloudflare account. In the dashboard, add the domain `golemcraftworks.com` on the Free plan.
2. Cloudflare copies your existing DNS records. Keep all of them for now, including the ones for `golemcraftworks.com` and `www` that point at the old link page: the main address keeps showing the link page until you go public.
3. At GoDaddy, change the domain's nameservers to the two Cloudflare shows you.
4. Wait until Cloudflare lists the domain as **Active**.

The first deploy in step 4 creates the `preview` address by itself; there is no DNS record to add for it.

### 3. Square

1. Go to the Square Developer Console, create an application.
2. Start in **Sandbox**: copy the sandbox access token and a sandbox location ID.
3. Later for real use, copy your **Production** access token and your shop's **Location ID** (Locations page in the Developer Console).
4. Under **Webhooks**, add a subscription:
   - URL: `https://preview.golemcraftworks.com/webhooks/square`
   - Events: `inventory.count.updated`, `catalog.version.updated`, `payment.created`, and `payment.updated`
   - Copy the **signature key**.
5. Make sure the tax you charge in person is set on your items in Square. In-person sales and website pickup orders use it; shipped website orders don't add sales tax (see [Known limits](#known-limits)).

### 4. First deploy

```bash
npm install
npx wrangler login
cd worker
npx wrangler kv namespace create GC_KV        # paste the id into wrangler.toml
```

Fill in `SQUARE_LOCATION_ID` in `worker/wrangler.toml` (the Etsy values can wait for step 5). Deploy once so the Worker exists, then add the secrets from the base directory:

```bash
npx wrangler deploy
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
npx wrangler secret put ADMIN_TOKEN           # any long random string, keep it private (weaker than most)
```

The site is now at https://preview.golemcraftworks.com, showing your Square inventory.

Set your email, Instagram and Etsy links in `site/ts/pages/config.ts`, and run `npm run deploy` from the project folder.

`SQUARE_WEBHOOK_URL` in wrangler.toml must exactly match the URL you gave Square, or webhook signatures won't verify.

The admin addresses (`/admin/...`) answer "Not found" unless `?token=` matches `ADMIN_TOKEN` exactly. Keep the token to letters and numbers: characters such as `+`, `&`, `#`, and `%` get changed on the way through an address.

### 5. Etsy

1. Register an app at developers.etsy.com. Copy the **keystring** and **shared secret**.
2. Put the keystring in `ETSY_KEYSTRING` in wrangler.toml, and from `worker/` run `npx wrangler secret put ETSY_SHARED_SECRET`.
3. In the app's settings, add the callback URL `https://preview.golemcraftworks.com/admin/etsy/callback`. It has to match exactly; if it doesn't, Etsy's sign-in page says "The requested redirect URL is not permitted."
4. Run `npm run deploy`, then visit `https://preview.golemcraftworks.com/admin/etsy/connect?token=YOUR_ADMIN_TOKEN` and approve. The confirmation page shows your **shop ID**; put it in `ETSY_SHOP_ID` and deploy again.
5. In Etsy's Webhooks portal, add an endpoint for `order.paid` pointing to `https://preview.golemcraftworks.com/webhooks/etsy`. Copy its signing secret (starts with `whsec_`), then from `worker/` run `npx wrangler secret put ETSY_WEBHOOK_SECRET`.

The hourly check also refreshes the Etsy sign-in, which otherwise expires after 90 days unused.

### 6. Test the sync safely, then turn it on

`SYNC_DRY_RUN = "true"` is the default. In this mode the Worker logs what it would change on Etsy and Square but changes nothing.

1. Leave dry run on for a few days of normal selling.
2. Check `https://preview.golemcraftworks.com/admin/status?token=YOUR_ADMIN_TOKEN`: recent activity, SKUs missing on either side, and the last hourly check.
3. When the planned changes look right, set `SYNC_DRY_RUN = "false"` and `npm run deploy`.
4. Place one real website order for something cheap (pickup option) to confirm checkout, receipt and the Etsy update end to end.

To run the hourly check on demand: `curl -X POST "https://preview.golemcraftworks.com/admin/reconcile?token=YOUR_ADMIN_TOKEN"`.

## Going public

This moves the shop from `preview.golemcraftworks.com` to `golemcraftworks.com` and lets search engines in. Do it once setup steps 1 to 6 are done and the shop looks right at the preview address.

Pick a quiet hour. Between steps 3 and 5 below, sale notifications from Square and Etsy have nowhere to land; the hourly check picks up anything missed. After step 3 the preview address stops working, and every address in this file that says `preview.golemcraftworks.com` becomes `golemcraftworks.com`.

1. **Read the policy page once more.** `site/shipping/index.html` says how soon orders ship and what the return policy is; Google requires both.
2. **Free up the main address.** In Cloudflare DNS, delete the `A` records for `golemcraftworks.com` and `www` that point at the old link page. Keep the email records (`MX`, `TXT`). The deploy creates its own records and fails if the old ones are in the way. You can also turn off forwarding at GoDaddy; nothing uses it after this.
3. **Switch the settings** in `worker/wrangler.toml`, then run `npm run deploy`:
   - Routes: remove the `preview.golemcraftworks.com` route and uncomment the two for `golemcraftworks.com` and `www.golemcraftworks.com`.
   - `SITE_URL = "https://golemcraftworks.com"`
   - `SQUARE_WEBHOOK_URL = "https://golemcraftworks.com/webhooks/square"`
   - `NOINDEX = "false"`
4. **Square.** In the Developer Console under Webhooks, edit the subscription's URL to `https://golemcraftworks.com/webhooks/square`, exactly as in `SQUARE_WEBHOOK_URL`. If you make a new subscription instead of editing, it has a new signature key: from `worker/` run `npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY`.
5. **Etsy.**
   - In the Webhooks portal, point the `order.paid` endpoint at `https://golemcraftworks.com/webhooks/etsy`. If that gives you a new signing secret, from `worker/` run `npx wrangler secret put ETSY_WEBHOOK_SECRET`.
   - In the app's settings, add the callback URL `https://golemcraftworks.com/admin/etsy/callback`. The existing Etsy connection carries over; this is only for the day you need to connect again.
6. **Check it.**
   - `https://golemcraftworks.com` shows the shop, and a product page opens.
   - `https://golemcraftworks.com/robots.txt` says `Allow: /`.
   - Change the stock of something in Square that is also listed on Etsy, then look at `https://golemcraftworks.com/admin/status?token=YOUR_ADMIN_TOKEN`: the change should be in the recent activity within a minute.
7. **Tell the search engines.** Follow the list in the next section.

Nothing changes for commission emails: they already send from `golemcraftworks.com`.

## Search engines, AI assistants and Google Shopping

The Worker builds the home page, each category page (`/shop/<category>`), and each product page (`/product/<name>`) in full, plus `/sitemap.xml`, `/robots.txt`, `/llms.txt` (a plain-text guide for AI assistants) and `/feeds/google.xml` (a product feed). All of them update from Square on their own.

While `NOINDEX = "true"` in `worker/wrangler.toml`, search engines are told to stay away. That is right for the preview address; [Going public](#going-public) turns it off.

After going public, once:

1. **Check the policy page** says how soon orders ship and what the return policy is. Google requires both to be on the site.
2. **Google Search Console** (search.google.com/search-console): add `golemcraftworks.com`, verify it with the DNS record it gives you (add the TXT record in Cloudflare DNS), then under Sitemaps submit `https://golemcraftworks.com/sitemap.xml`.
3. **Bing Webmaster Tools** (bing.com/webmasters): sign in and choose "Import from Google Search Console". That copies the site and sitemap across. ChatGPT's search draws on Bing, so this one matters for AI assistants too.
4. **Google Merchant Center** (merchants.google.com), for free listings in the Shopping tab:
   1. Create an account for Golem Craftworks and claim the website (it reuses the Search Console verification).
   2. Fill in business details, then the shipping setting (flat $8, United States) and the return policy, matching the policy page.
   3. Add products: choose "Add products from a file", pick the scheduled fetch option, and give it `https://golemcraftworks.com/feeds/google.xml`, fetched daily.
   4. Make sure free listings are turned on, then wait for review (usually a few days). The Diagnostics page lists anything Google rejects; the common ones are photos with text or watermarks, and prices that don't match the page.

Handmade pieces have no barcode. The feed already says so (`identifier_exists: no`), so ignore prompts to add GTINs.

## Listings from Etsy

To bring Etsy listings into Square, download **Currently for Sale Listings** from Etsy (Shop Manager > Settings > Options > Download Data), then:

```bash
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-listings.ts EtsyListingsDownload.csv                                        # preview
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-listings.ts EtsyListingsDownload.csv --category="8-piece RPG Dice" --apply  # create
```

A listing whose SKU isn't in Square becomes a new item (title, description, price, SKU) with a stock count of 1. A listing whose SKU is already in Square only updates that item's title and description. Extra columns in the export, such as tags and materials, are saved on the item as custom attributes. It's safe to run twice. Then copy the photos across with the next step.

## Photos from Etsy

Your dice photos live on Etsy. To copy them into Square (so Square holds everything the site shows):

```bash
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv          # preview
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv --apply  # upload
```

It matches by SKU, then by exact title, skips Square items that already have photos, and lists any Etsy listings it couldn't match.

## Dice set descriptions

Every dice set shares one description, kept in `worker/src/descriptions.ts`. Edit it there, then `npm run deploy`, and every set follows. A set's description in Square holds only what's particular to that set; the site drops it into the template where `{NOTES}` is. An item counts as a dice set when it's named like `"JAVA" TTRPG Dice Set`.

To cut the existing Square descriptions down to their set-specific parts (once):

```bash
SQUARE_ACCESS_TOKEN=xxx node tools/clear-dice-descriptions.ts          # preview: shows what each set keeps
SQUARE_ACCESS_TOKEN=xxx node tools/clear-dice-descriptions.ts --apply
```

## New dice sets on Etsy

When you save a new dice set in Square, the Worker makes an Etsy draft for it, usually within a minute. It also checks at half past every hour, in case a save was missed.

A Square item gets a draft when all of these are true:

- It is in a category named in `ETSY_DRAFT_CATEGORIES` in wrangler.toml (now `8-piece RPG Dice`). Nothing in any other category is ever listed for you.
- It has one variation, with a SKU, stock tracking on, and at least one in stock.
- It is named like `"JAVA" TTRPG Dice Set`. A duplicate still called `"JAVA" TTRPG Dice Set Copy` waits until it's renamed, and `lastEtsyDraftsCheck` says so.
- No Etsy listing in any state (active, inactive, sold out, draft, or expired) carries that SKU, and no draft was made for it before.

The draft is built like this:

- **Settings** are copied from the Etsy draft whose title starts with `TEMPLATE`: category, shipping profile, return policy, processing time, shop section, tags, materials, weight and size, who made it and when, and auto-renew. Change the template and later drafts follow. Attributes (the extra category details Etsy asks for) are not copied.
- **Title** is the template's title with `TEMPLATE` replaced by the set's name: `TEMPLATE 8-Piece Dice Set | …` becomes `JAVA 8-Piece Dice Set | …`.
- **Description, price, stock, and SKU** come from Square. The description is the shared dice description with the set's own notes in it.
- **Photos** are the item's Square photos, up to 10, in the same order.

Then review the draft on Etsy and publish it. Etsy charges its listing fee when you publish, not for the draft. Once it's published, the stock sync looks after it like any other listing.

Things to know:

- **Dry run.** While `SYNC_DRY_RUN = "true"`, nothing is created. `/admin/status` shows which SKUs are waiting under `lastEtsyDraftsCheck`, and the recent activity says what would be made.
- **A few at a time.** Each run can only do so much, mostly because of photos: one set with 10 photos, or two with 4 each. If you save several sets in a row, the rest are picked up on the next save or the next hourly check. `lastEtsyDraftsCheck` in `/admin/status` lists what is still waiting.
- **Photos follow Square.** When you change a dice item's photos in Square (say, swapping a quick placeholder for proper ones), its Etsy listing's photos are replaced with Square's, in Square's order, usually within a minute. This goes for drafts and published listings alike, including dice listings that were on Etsy before this was set up. Photo changes made on Etsy are overwritten the next time the Square photos change. Removing every photo in Square leaves Etsy's as they are.
- **Nothing else follows.** Title, description, and price are set when the draft is made. Later changes to them in Square don't reach Etsy. To run it now: `curl -X POST "https://preview.golemcraftworks.com/admin/etsy/drafts?token=YOUR_ADMIN_TOKEN"`.
- **Once per SKU.** If you delete a draft on Etsy, it isn't made again.
- **A draft's stock isn't kept in step.** If the set sells before you publish, don't publish the draft. If you do, the hourly check turns the listing off within the hour.
- **Publishing without review.** Set `ETSY_DRAFTS_AUTO_PUBLISH = "true"` and deploy. Each new set is then listed straight away, and Etsy charges its fee each time.
- **Turning it off.** Set `ETSY_DRAFT_CATEGORIES = ""` and deploy.

## Day to day

- **New piece:** add it in Square with a SKU, price, photo and stock count. It appears on the site within a minute, with no deploy. A dice set gets an Etsy draft made for it within a minute or so. For anything else you want on Etsy, create the Etsy listing with the same SKU; the sync picks it up within the hour.
- **Hide something from the website** (market-only items): put it in a Square category, add that category name to `HIDDEN_CATEGORIES` in wrangler.toml, then `npm run deploy`.
- **Change shipping:** `SHIPPING_FLAT_CENTS` in `worker/wrangler.toml`, then `npm run deploy`. Checkout, the cart, the shipping page and the product data for search engines all follow it. Update the shipping setting in Google Merchant Center to match.

## Known limits

- **Two buyers, one piece, same minute.** Website checkout re-checks stock before sending someone to pay, but Square doesn't hold the item while they're paying, and Etsy updates take a few seconds. A simultaneous double sale is possible but rare. Refund one in Square or Etsy if it happens.
- **Etsy cancellations** aren't added back to Square automatically. Adjust the count in Square and the sync will update Etsy.
- **Turning an Etsy listing back on** may count as a renewal with Etsy's listing fee.
- **Sales tax** is not added to shipped website orders, because Square can't work out tax by destination for this kind of checkout. Most ship out of state, where none is due. On orders shipped within Wisconsin you pay it out of the price; the order email marks those "WISCONSIN ORDER" so you can total them when you file. Pickup orders and in-person sales are charged the taxes set on your items in Square. The switch is `auto_apply_taxes` in `worker/src/square.ts`; turning it on for shipped orders charges every buyer your rate wherever they are.
- **Commission form** only sends email once Resend is set up (below). Until then it tells the visitor to email you directly.

## Commission emails

The commission form posts to the Worker, which sends two emails through [Resend](https://resend.com) (free plan covers 100 a day):

- To you (`COMMISSION_TO`): **New commission request: Dice vault (Jane Doe)**. Replying goes straight to the client.
- To the client: **Golem Craftworks received your commission request**, with a copy of what they sent. Replying goes to you.

Setup:

1. Create a Resend account, add the domain `golemcraftworks.com`, and add the DNS records it shows you in Cloudflare (the domain's DNS lives there after setup step 2). Until the domain is verified Resend will only deliver to your own address, so clients get no confirmation.
2. Create an API key, then from `worker/` run `npx wrangler secret put RESEND_API_KEY`.
3. Check `EMAIL_FROM` and `COMMISSION_TO` in wrangler.toml, then `npm run deploy`.
4. Send yourself a test request from the live form using a second email address.

Each visitor is limited to 5 requests an hour. Failures show up in `/admin/status`.

### Sending from a golemcraftworks.com address in Gmail

Gmail can send as `anything@golemcraftworks.com` by handing the mail to Resend. The address has to receive mail first (Cloudflare → Email → Email Routing, forwarding to the shop Gmail), because Gmail emails a confirmation code to it.

In Gmail on desktop: gear icon → **See all settings** → **Accounts and Import** → **Send mail as** → **Add another email address**. Enter the name and address, leave **Treat as an alias** checked, then fill in:

| Field | Value |
|---|---|
| SMTP Server | `smtp.resend.com` |
| Port | `587` |
| Username | `resend` (literally that word) |
| Password | a Resend API key (use one made for Gmail, separate from the Worker's, with "Sending access") |
| Secured connection | TLS |

If port 587 fails, use `465` with SSL. Enter the confirmation code Gmail sends, then select **Reply from the same address the message was sent to**. The same API key works for every alias. These emails count toward the same Resend daily limit as the commission form.

## Daily report

Once a day (13:17 UTC, early morning Central) the Worker looks at the same information as `/admin/status` and emails you at `SALES_TO` **only if something needs a look**:

- Etsy disconnected, the sync left in dry-run mode, or the hourly check not running.
- Errors from the last hourly check or from making Etsy drafts.
- Pieces back in stock in Square that are waiting for you to publish on Etsy.
- A SKU that's on one side only. Each is mentioned once, when it first shows up, since many are on purpose.
- Anything that failed in the last day (an email that didn't send, Square or Etsy not answering).

No email means nothing was wrong. To send it now: `curl -X POST "https://preview.golemcraftworks.com/admin/report?token=YOUR_ADMIN_TOKEN"`. The reply shows what the report contains even when no email goes out. It needs Resend, as in [Commission emails](#commission-emails).

## Order emails

When someone pays for a website order, the Worker emails you (at `SALES_TO` in `worker/wrangler.toml`) with the name and address to ship to (or a pickup note), the buyer's email and phone, what sold, and the money: shipping, sales tax, total paid, and Square's fee when Square has posted it. Replying writes to the buyer. Square sends the buyer their receipt; in-person sales don't trigger an email.

This needs two things:

- Resend set up, as in [Commission emails](#commission-emails).
- The Square webhook subscription (setup step 3) must include `payment.created` and `payment.updated`. To add them later: Square Developer Console, your app, **Webhooks → Subscriptions**, edit the subscription and tick both. The URL and signature key stay the same.

If the email fails to send, `/admin/status` shows a line starting "WEBSITE ORDER", and the hourly check sends it: each hour it looks through the last day's website payments for any that never got their email. The same payment events also update the sales count on the site straight away.

## Reviews

The reviews page shows Etsy reviews plus ones left on the site. A review left on the site shows straight away, and you get an email with a link to hide or delete it. One with a web address in it is held back as likely spam until you press **Show on the site** from that link. Every site review is also listed at `https://preview.golemcraftworks.com/admin/reviews?token=YOUR_ADMIN_TOKEN`. The notification email uses the same Resend setup as [Commission emails](#commission-emails).

### Spam check (Turnstile)

Cloudflare Turnstile is a free check that the visitor is a person, usually without asking them to do anything. It's off until both keys below are set. Without it the form still has a hidden trap field, a too-fast-to-be-human timer, and a limit of three reviews a day per visitor.

1. In the Cloudflare dashboard, open **Turnstile** and add a widget. Name it anything, add the hostname `golemcraftworks.com` (this covers `preview.golemcraftworks.com` too), and leave the mode on **Managed**.
2. Copy the **site key** into `turnstileSiteKey` in `site/ts/pages/config.ts`. This one is public, so it's fine in the repo.
3. Copy the **secret key**, then from `worker/` run `npx wrangler secret put TURNSTILE_SECRET` and paste it.
4. Run `npm run deploy` straight after. Between steps 3 and 4 the Worker expects the check but the page doesn't show it yet, so reviews sent in that gap are refused.
5. Open the reviews page: a small Cloudflare box appears above the Send button. Send a test review to make sure it goes through.

To turn it off again, empty `turnstileSiteKey`, run `npx wrangler secret delete TURNSTILE_SECRET` from `worker/`, and deploy.

## GitHub

The repo is private and is only a backup and history of the source. It holds no secrets: API keys live in Cloudflare (`wrangler secret put`) and in `worker/.dev.vars`, which git ignores. Never paste a key into `wrangler.toml` or any other tracked file.

`site/js/` is built, not committed. `npm run deploy`, `npm run dev` and `npm test` each build it first, so a fresh copy of the repo only needs `npm install`.
