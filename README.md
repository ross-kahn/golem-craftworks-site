# Golem Craftworks website

A storefront for golemcraftworks.com that sells straight from your Square inventory, plus a small Cloudflare Worker that keeps Etsy in step with Square.

```
site/      The website. Static files for GitHub Pages.
  index.html            Shop (home)
  product/              Product page  (/product/?id=...)
  about/  commissions/  thanks/   Content pages
  styles/main.css       All styling
  ts/config.ts          The only file you need to edit for a basic launch
  ts/                   Shop, product, cart and form scripts (TypeScript source)
  js/                   Built from ts/ by `npm run build`. Don't edit by hand.
  assets/               Logo, favicon, hero golem
  data/demo-products.json   Sample products used until the Worker is connected
worker/    Cloudflare Worker in TypeScript (Square + Etsy logic, keeps your API keys secret)
tools/     One-time helper to copy Etsy photos into Square
```

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

## Before anything else: SKUs

1. In Square, give every item variation a SKU. One-of-a-kind dice each get their own (for example `DICE-0412`). Standard items get one per option (`YZ-WAL`, `YZ-CHE`, `TWR-BLK`).
2. In Etsy, put the same SKU on the matching listing. For listings with variations (wood species, colors), each variation's SKU must match the Square variation's SKU.
3. In Square, turn on stock tracking for anything you want synced. Items without tracking show as "Made to order" on the site and are never touched on Etsy.

After setup, `/admin/status` lists any SKUs found on only one side so you can fix gaps.

## 1. Put the site on GitHub Pages

1. Create a GitHub repo and push the contents of `site/` to it (or push this whole folder and set Pages to deploy from `/site` with a GitHub Action).
2. In the repo: **Settings → Pages**, deploy from the `main` branch.
3. `site/CNAME` already contains `golemcraftworks.com`.
4. At GoDaddy, turn off the current forwarding to your link page, then set DNS:
   - `A` records for `@` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www` → `YOUR-GITHUB-USERNAME.github.io`
5. Back in GitHub Pages settings, tick **Enforce HTTPS** once the certificate is issued.

Until step 3 below is done, the site runs in demo mode with sample products and checkout turned off.

## 2. Square

1. Go to the Square Developer Console, create an application.
2. Start in **Sandbox**: copy the sandbox access token and a sandbox location ID.
3. Later for real use, copy your **Production** access token and your shop's **Location ID** (Locations page in the Developer Console).
4. Under **Webhooks**, add a subscription:
   - URL: `https://golem-craftworks.<your-subdomain>.workers.dev/webhooks/square`
   - Events: `inventory.count.updated` and `catalog.version.updated`
   - Copy the **signature key**.
5. Make sure the tax you charge in person is set on your items in Square. Online checkout applies the same catalog taxes.

## 3. Deploy the Worker (free Cloudflare plan)

```bash
npm install                                   # once, in the project folder
cd worker
npx wrangler login
npx wrangler kv namespace create GC_KV        # paste the id into wrangler.toml
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
npx wrangler secret put ETSY_SHARED_SECRET
npx wrangler secret put ETSY_WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN           # any long random string, keep it private
# fill in the REPLACE_ME values in wrangler.toml, then:
npx wrangler deploy
```

Then in `site/ts/config.ts` set `apiBase` to the Worker URL (`https://golem-craftworks.<your-subdomain>.workers.dev`), set your email, Instagram and Etsy links, and run `npm run build`.

`SQUARE_WEBHOOK_URL` in wrangler.toml must exactly match the URL you gave Square, or webhook signatures won't verify.

## 4. Etsy

1. Register an app at developers.etsy.com. Copy the **keystring** and **shared secret**.
2. In the app's settings, add the callback URL `https://golem-craftworks.<your-subdomain>.workers.dev/admin/etsy/callback`.
3. Visit `https://golem-craftworks.<your-subdomain>.workers.dev/admin/etsy/connect?token=YOUR_ADMIN_TOKEN` and approve. The confirmation page shows your **shop ID**; put it in `ETSY_SHOP_ID` and redeploy.
4. In Etsy's Webhooks portal, add an endpoint for `order.paid` pointing to `/webhooks/etsy` on the Worker. Copy its signing secret (starts with `whsec_`) into the `ETSY_WEBHOOK_SECRET` secret.

The hourly check also refreshes the Etsy sign-in, which otherwise expires after 90 days unused.

## 5. Test safely, then go live

`SYNC_DRY_RUN = "true"` is the default. In this mode the Worker logs what it would change on Etsy and Square but changes nothing.

1. Leave dry run on for a few days of normal selling.
2. Check `/admin/status?token=YOUR_ADMIN_TOKEN`: recent activity, SKUs missing on either side, and the last hourly check.
3. When the planned changes look right, set `SYNC_DRY_RUN = "false"` and `npx wrangler deploy`.
4. Place one real website order for something cheap (pickup option) to confirm checkout, receipt and the Etsy update end to end.

To run the hourly check on demand: `curl -X POST "https://.../admin/reconcile?token=YOUR_ADMIN_TOKEN"`.

## Photos from Etsy

Your dice photos live on Etsy. To copy them into Square (so Square holds everything the site shows):

```bash
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv          # preview
SQUARE_ACCESS_TOKEN=xxx node tools/import-etsy-images.ts EtsyListingsDownload.csv --apply  # upload
```

It matches by SKU, then by exact title, skips Square items that already have photos, and lists any Etsy listings it couldn't match.

## Day to day

- **New piece:** add it in Square with a SKU, price, photo and stock count. It appears on the site within a minute. If you also want it on Etsy, create the Etsy listing with the same SKU; the sync picks it up within the hour.
- **Hide something from the website** (market-only items): put it in a Square category and add that category name to `HIDDEN_CATEGORIES`.
- **Change shipping:** `SHIPPING_FLAT_CENTS` in wrangler.toml (what's charged) and `shippingCents` in `site/ts/config.ts` (what the cart shows; run `npm run build` after).

## Known limits

- **Two buyers, one piece, same minute.** Website checkout re-checks stock before sending someone to pay, but Square doesn't hold the item while they're paying, and Etsy updates take a few seconds. A simultaneous double sale is possible but rare. Refund one in Square or Etsy if it happens.
- **Etsy cancellations** aren't added back to Square automatically. Adjust the count in Square and the sync will update Etsy.
- **Turning an Etsy listing back on** may count as a renewal with Etsy's listing fee.
- **Sales tax** uses the taxes attached to your items in Square. If you need destination-based tax for shipped orders, that needs a separate decision.
- **Commission form** only sends email once the Worker and Resend are set up (below). In demo mode it opens the visitor's email app with the request filled in.

## Commission emails

The commission form posts to the Worker, which sends two emails through [Resend](https://resend.com) (free plan covers 100 a day):

- To you (`COMMISSION_TO`): **New commission request: Dice vault (Jane Doe)**. Replying goes straight to the client.
- To the client: **Golem Craftworks received your commission request**, with a copy of what they sent. Replying goes to you.

Setup:

1. Create a Resend account, add the domain `golemcraftworks.com`, and add the DNS records it shows you at GoDaddy. Until the domain is verified Resend will only deliver to your own address, so clients get no confirmation.
2. Create an API key, then `npx wrangler secret put RESEND_API_KEY`.
3. Check `EMAIL_FROM` and `COMMISSION_TO` in wrangler.toml, then `npx wrangler deploy`.
4. Send yourself a test request from the live form using a second email address.

Each visitor is limited to 5 requests an hour. Failures show up in `/admin/status`.

## Developing

Everything is TypeScript. Needs Node 22.18 or newer. Run these from the project folder:

```bash
npm install          # once
npm run build        # site/ts/*.ts -> site/js/*.js (the pages load the js/ files)
npm run watch        # same, rebuilding as you edit
npm run typecheck    # type-check the site, the Worker and tools/
npm test             # Worker tests against fake Square/Etsy APIs
npm run deploy       # wrangler deploy (it compiles the Worker's TypeScript itself)
cd site && python3 -m http.server 8000     # http://localhost:8000 (demo mode)
```

The built `site/js/` files are committed, because GitHub Pages serves the folder as it is. After changing anything in `site/ts/`, run `npm run build` and commit both.

**Network share:** this project sits on `\openmediavault`, which doesn't allow running programs stored on it. Building, type-checking and tests work there. `npm run deploy` and `npm run dev` do not, because Wrangler's bundler is a program inside `node_modules`. Run those from a copy on a local disk, or allow execution on the share.
