# Golem Craftworks website

A storefront for golemcraftworks.com that sells straight from your Square inventory and keeps Etsy in step with Square.

The whole thing runs on Cloudflare's free plan as one Worker: Cloudflare serves the pages in `site/`, and the Worker code handles checkout, the commission form and the Square/Etsy sync. GitHub holds the source in a private repo and plays no part in hosting.

```
site/      The website. Static files, served by Cloudflare as they are.
  index.html            Shop (home)
  product/              Product page  (/product/?id=...)
  about/  commissions/  thanks/   Content pages
  styles/main.css       All styling
  ts/config.ts          The only file you need to edit for a basic launch
  ts/                   Shop, product, cart and form scripts (TypeScript source)
  js/                   Built from ts/ by `npm run build`. Don't edit by hand.
  assets/               Logo, favicon, hero golem
  data/demo-products.json   Sample products used until the Worker is connected
  .assetsignore         Files in site/ that are not published (the TypeScript source)
worker/    Cloudflare Worker in TypeScript (Square + Etsy logic, keeps your API keys secret)
  wrangler.toml         Cloudflare settings: domain, site folder, shop options
tools/     One-time helper to copy Etsy photos into Square
```

## Build and deploy

Needs Node 22.18 or newer. Run these from the project folder.

```bash
npm install          # once per computer
npm run prepare      # once per copy of the repo: turns on the pre-commit hook
npx wrangler login   # once per computer: opens Cloudflare in your browser
npm run deploy       # builds site/ts -> site/js, then publishes the site and the Worker together
```

`npm run deploy` is the only way anything goes live. It publishes whatever is in the folder on your computer, committed or not. Pushing to GitHub does not deploy.

A normal change looks like this:

```bash
npm run watch        # rebuilds site/js as you edit site/ts (leave it running)
npm run dev          # the site and the Worker at http://localhost:8787
npm run typecheck    # type-check the site, the Worker and tools/
npm test             # Worker tests against fake Square/Etsy APIs
git commit           # the hook rebuilds site/js and adds it to the commit
git push
npm run deploy
```

- **What needs a deploy:** any change to `site/`, `worker/src/` or `worker/wrangler.toml`. Secrets set with `wrangler secret put` take effect at once and need no deploy.
- **Local preview without Cloudflare:** `cd site && python3 -m http.server 8000`, then open http://localhost:8000. This serves the pages only, so it only works in demo mode (`apiBase: ""`).
- **`npm run dev` with real data:** put the secrets in `worker/.dev.vars`, one `NAME=value` per line. Git ignores that file. Use sandbox Square credentials there.
- **Undo a bad deploy:** `npx wrangler rollback` from `worker/` goes back to the previous version.

## How inventory stays in sync

Square is the single source of truth. You only ever change stock in Square.

| What happens | Who updates what |
|---|---|
| Sale at a market (Square POS) | Square lowers stock → Square tells the Worker → Worker updates the Etsy listing |
| Sale on the website | The website checks out through Square, so Square lowers stock automatically → same path to Etsy |
| Sale on Etsy | Etsy tells the Worker → Worker records the sale in Square |
| You edit stock in Square (restock, new piece) | Same path to Etsy. A sold-out Etsy listing the sync turned off is turned back on. |
| Every hour | A safety check catches any Etsy sale whose notification was missed, then lowers Etsy anywhere it shows more than Square has. It never raises Etsy stock, so it can't relist a sold piece. |

Products are matched between Square and Etsy **by SKU**. That's the one bit of setup that matters most.

## First-time setup

Do these in order. Steps 1 to 4 put the shop online; 5 and 6 connect Etsy.

### 1. SKUs

1. In Square, give every item variation a SKU. One-of-a-kind dice each get their own (for example `DICE-0412`). Standard items get one per option (`YZ-WAL`, `YZ-CHE`, `TWR-BLK`).
2. In Etsy, put the same SKU on the matching listing. For listings with variations (wood species, colors), each variation's SKU must match the Square variation's SKU.
3. In Square, turn on stock tracking for anything you want synced. Items without tracking show as "Made to order" on the site and are never touched on Etsy.

After setup, `/admin/status` lists any SKUs found on only one side so you can fix gaps.

### 2. Move the domain to Cloudflare

The Worker can only be attached to a domain that Cloudflare manages, so the domain's DNS moves from GoDaddy to Cloudflare. The domain stays registered at GoDaddy.

1. Create a free Cloudflare account. In the dashboard, add the domain `golemcraftworks.com` on the Free plan.
2. Cloudflare copies your existing DNS records. Keep any email records (`MX`, `TXT`). Delete the records for `@` and `www` that point at the old link page; the deploy creates its own and fails if others are in the way.
3. At GoDaddy, turn off forwarding to the link page, then change the domain's nameservers to the two Cloudflare shows you.
4. Wait until Cloudflare lists the domain as **Active**. The domain shows nothing from then until the first deploy in step 4.

### 3. Square

1. Go to the Square Developer Console, create an application.
2. Start in **Sandbox**: copy the sandbox access token and a sandbox location ID.
3. Later for real use, copy your **Production** access token and your shop's **Location ID** (Locations page in the Developer Console).
4. Under **Webhooks**, add a subscription:
   - URL: `https://golemcraftworks.com/webhooks/square`
   - Events: `inventory.count.updated` and `catalog.version.updated`
   - Copy the **signature key**.
5. Make sure the tax you charge in person is set on your items in Square. Online checkout applies the same catalog taxes.

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

The site is now at https://golemcraftworks.com in demo mode: sample products, checkout turned off.

To show your real inventory, set `apiBase: "/"` in `site/ts/config.ts`, set your email, Instagram and Etsy links there too, and run `npm run deploy` from the project folder.

`SQUARE_WEBHOOK_URL` in wrangler.toml must exactly match the URL you gave Square, or webhook signatures won't verify.

### 5. Etsy

1. Register an app at developers.etsy.com. Copy the **keystring** and **shared secret**.
2. Put the keystring in `ETSY_KEYSTRING` in wrangler.toml, and from `worker/` run `npx wrangler secret put ETSY_SHARED_SECRET`.
3. In the app's settings, add the callback URL `https://golemcraftworks.com/admin/etsy/callback`.
4. Run `npm run deploy`, then visit `https://golemcraftworks.com/admin/etsy/connect?token=YOUR_ADMIN_TOKEN` and approve. The confirmation page shows your **shop ID**; put it in `ETSY_SHOP_ID` and deploy again.
5. In Etsy's Webhooks portal, add an endpoint for `order.paid` pointing to `https://golemcraftworks.com/webhooks/etsy`. Copy its signing secret (starts with `whsec_`), then from `worker/` run `npx wrangler secret put ETSY_WEBHOOK_SECRET`.

The hourly check also refreshes the Etsy sign-in, which otherwise expires after 90 days unused.

### 6. Test safely, then go live

`SYNC_DRY_RUN = "true"` is the default. In this mode the Worker logs what it would change on Etsy and Square but changes nothing.

1. Leave dry run on for a few days of normal selling.
2. Check `https://golemcraftworks.com/admin/status?token=YOUR_ADMIN_TOKEN`: recent activity, SKUs missing on either side, and the last hourly check.
3. When the planned changes look right, set `SYNC_DRY_RUN = "false"` and `npm run deploy`.
4. Place one real website order for something cheap (pickup option) to confirm checkout, receipt and the Etsy update end to end.

To run the hourly check on demand: `curl -X POST "https://golemcraftworks.com/admin/reconcile?token=YOUR_ADMIN_TOKEN"`.

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

## Day to day

- **New piece:** add it in Square with a SKU, price, photo and stock count. It appears on the site within a minute, with no deploy. If you also want it on Etsy, create the Etsy listing with the same SKU; the sync picks it up within the hour.
- **Hide something from the website** (market-only items): put it in a Square category, add that category name to `HIDDEN_CATEGORIES` in wrangler.toml, then `npm run deploy`.
- **Change shipping:** `SHIPPING_FLAT_CENTS` in wrangler.toml (what's charged) and `shippingCents` in `site/ts/config.ts` (what the cart shows), then `npm run deploy`.

## Known limits

- **Two buyers, one piece, same minute.** Website checkout re-checks stock before sending someone to pay, but Square doesn't hold the item while they're paying, and Etsy updates take a few seconds. A simultaneous double sale is possible but rare. Refund one in Square or Etsy if it happens.
- **Etsy cancellations** aren't added back to Square automatically. Adjust the count in Square and the sync will update Etsy.
- **Turning an Etsy listing back on** may count as a renewal with Etsy's listing fee.
- **Sales tax** uses the taxes attached to your items in Square. If you need destination-based tax for shipped orders, that needs a separate decision.
- **Commission form** only sends email once Resend is set up (below). In demo mode it opens the visitor's email app with the request filled in.

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

## GitHub

The repo is private and is only a backup and history of the source. It holds no secrets: API keys live in Cloudflare (`wrangler secret put`) and in `worker/.dev.vars`, which git ignores. Never paste a key into `wrangler.toml` or any other tracked file.

`site/js/` is committed so a fresh copy of the repo can be previewed without building. The pre-commit hook in `.githooks/` rebuilds it whenever a commit touches `site/ts/`, and stops the commit if the build fails. On a new copy of the repo, run `npm install` and `npm run prepare` once.

**Network share:** if the project sits on `\\openmediavault`, which doesn't allow running programs stored on it, building, type-checking and tests still work there. `npm run deploy` and `npm run dev` do not, because Wrangler's bundler is a program inside `node_modules`. Run those from a copy on a local disk, or allow execution on the share.
