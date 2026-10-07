// Inventory sync. Square is the source of truth; Etsy follows it.
//
//   Square stock changes (in-person sale, website sale, manual edit)
//     -> Square webhook -> set the Etsy listing to match
//   Etsy sale
//     -> Etsy webhook (plus an hourly safety check) -> record the sale in Square
//
// Safety rules:
//   * Webhook handlers re-read live Square counts instead of trusting payload order.
//   * Stock counts follow Square both ways, up and down. What the sync never does is put a listing
//     back on sale: one that sold out stays off (inactive or sold out) until it's published by hand on Etsy.
//   * The hourly check records missed Etsy sales in Square before it compares. If it can't read
//     Etsy's sales, it only lowers that run, so a missed sale can't be handed back out.
//   * SYNC_DRY_RUN=true logs every change it would make without making it.

import * as square from "./square.ts";
import * as etsyApi from "./etsy.ts";
import { logEvent, isTrue, errMsg } from "./util.ts";
import type {
  Env, EtsyListing, EtsyOffering, EtsyProduct, EtsyReceipt, EtsyWebhookEvent,
  PushResult, ReceiptResult, ReconcileReport, SquareWebhookEvent
} from "./types.ts";

const MAP_TTL_MS = 10 * 60 * 1000;

type SquareSkuMap = Record<string, string>; // sku -> variation id
interface EtsySkuMapEntry {
  at: number;
  map: Record<string, number>; // sku -> listing id
}

// ---------- SKU maps (cached in KV as single keys to stay inside free-tier write limits) ----------

export async function getSquareSkuMap(env: Env, { refresh = false } = {}): Promise<SquareSkuMap> {
  const cached = await env.GC_KV.get<{ at: number; map: SquareSkuMap }>("square:skumap", "json");
  if (cached && !refresh && Date.now() - cached.at < 24 * 3600 * 1000) return cached.map;
  const { skuMap } = await square.buildStorefront(env);
  await env.GC_KV.put("square:skumap", JSON.stringify({ at: Date.now(), map: skuMap }));
  return skuMap;
}

export async function getEtsySkuMap(env: Env, { refresh = false } = {}): Promise<EtsySkuMapEntry> {
  const cached = await env.GC_KV.get<EtsySkuMapEntry>("etsy:skumap", "json");
  if (cached && !refresh) return cached;
  return refreshEtsySkuMap(env);
}

async function refreshEtsySkuMap(env: Env, listings?: EtsyListing[]): Promise<EtsySkuMapEntry> {
  const ls = listings || (await etsyApi.fetchShopListings(env));
  const entry = { at: Date.now(), map: etsyApi.buildEtsySkuMap(ls) };
  await env.GC_KV.put("etsy:skumap", JSON.stringify(entry));
  return entry;
}

async function etsyListingForSku(env: Env, sku: string) {
  let entry = await getEtsySkuMap(env);
  if (!entry.map[sku] && Date.now() - entry.at > MAP_TTL_MS) entry = await refreshEtsySkuMap(env);
  return entry.map[sku] || null;
}

// ---------- Square -> Etsy ----------

const liveOffering = (p: EtsyProduct): Partial<EtsyOffering> => (p.offerings || []).find((o) => !o.is_deleted) || {};
const etsyQty = (p: EtsyProduct) => { const o = liveOffering(p); return o.is_enabled === false ? 0 : Number(o.quantity) || 0; };

/**
 * Make one Etsy listing's stock match `want` (sku -> quantity), in a single update. One result per SKU.
 * The listing's state is only ever changed one way: a listing with nothing left is turned off.
 * allowRaise=false means only lower Etsy stock.
 */
async function syncListing(
  env: Env, listing: Pick<EtsyListing, "listing_id" | "state">, want: Map<string, number>, { allowRaise = true } = {}
): Promise<PushResult[]> {
  const dry = isTrue(env.SYNC_DRY_RUN);
  const listingId = listing.listing_id;
  const inv = await etsyApi.getInventory(env, listingId);
  const products = (inv.products || []).filter((p) => !p.is_deleted);
  const skuOf = (p: EtsyProduct) => (p.sku || "").trim();
  const active = listing.state === "active";

  const results: PushResult[] = [];
  const changes = new Map<string, number>();
  const from = new Map<string, number>();
  for (const [sku, qty] of want) {
    const product = products.find((p) => skuOf(p) === sku);
    if (!product) { results.push({ sku, skipped: "sku-not-on-listing" }); continue; }
    const current = etsyQty(product);
    if (qty === current) results.push({ sku, unchanged: true });
    else if (qty > current && !allowRaise) results.push({ sku, skipped: "raise-not-allowed" });
    else { changes.set(sku, qty); from.set(sku, current); }
  }
  if (!changes.size) return results;

  // What's left sellable on the listing after this change? Etsy won't hold a listing at zero, so an
  // emptied one is turned off instead, keeping its last count.
  const remaining = products.reduce((n, p) => n + (changes.get(skuOf(p)) ?? etsyQty(p)), 0);
  let plan: string[];
  if (remaining === 0) plan = active ? ["deactivate-listing"] : [];
  // Etsy marked it sold out: writing stock to it could put it back on sale (and charge the listing fee).
  else if (listing.state === "sold_out") plan = [];
  else plan = ["set-quantity"];
  if (!plan.length) {
    changes.forEach((_, sku) => results.push(remaining === 0 ? { sku, unchanged: true } : { sku, skipped: "sold-out-on-etsy" }));
    return results;
  }

  const summary = { listingId, state: listing.state, plan, skus: [...changes].map(([sku, to]) => ({ sku, from: from.get(sku), to })) };
  if (dry) await logEvent(env, "DRY RUN: would update Etsy", summary);
  else {
    if (plan[0] === "deactivate-listing") await etsyApi.setListingState(env, listingId, "inactive");
    else await etsyApi.putInventory(env, listingId, etsyApi.inventoryForPut(inv, changes));
    await logEvent(env, "Updated Etsy to match Square", summary);
  }
  changes.forEach((to, sku) => results.push({ [dry ? "dryRun" : "updated"]: true, sku, listingId, from: from.get(sku), to, state: listing.state, plan }));
  return results;
}

/** Make the Etsy listing that carries `sku` show `qty`. */
export async function pushToEtsy(env: Env, sku: string, qty: number, { allowRaise = true } = {}): Promise<PushResult> {
  const listingId = await etsyListingForSku(env, sku);
  if (!listingId) return { skipped: "no-etsy-listing" };
  const listing = await etsyApi.getListing(env, listingId);
  const [result] = await syncListing(env, listing, new Map([[sku, qty]]), { allowRaise });
  return result;
}

export async function handleSquareInventoryEvent(env: Env, event: SquareWebhookEvent) {
  const counts = (event.data && event.data.object && event.data.object.inventory_counts) || [];
  const ids = [...new Set(
    counts.filter((c) => c.location_id === env.SQUARE_LOCATION_ID && c.catalog_object_type === "ITEM_VARIATION")
      .map((c) => c.catalog_object_id)
  )];
  if (!ids.length) return [];

  const skuMap = await getSquareSkuMap(env);
  const idToSku: Record<string, string> = Object.fromEntries(Object.entries(skuMap).map(([sku, id]) => [id, sku]));
  const missing = ids.filter((id) => !idToSku[id]);
  if (missing.length) {
    for (const v of await square.retrieveVariations(env, missing)) {
      const sku = (v.item_variation_data || {}).sku;
      if (sku) idToSku[v.id] = sku.trim();
    }
  }

  const live = await square.fetchCounts(env, ids); // re-read: webhooks can arrive out of order
  const results: (PushResult | { id: string; skipped: string } | { sku: string; error: string })[] = [];
  for (const id of ids) {
    const sku = idToSku[id];
    if (!sku) { results.push({ id, skipped: "no-sku" }); continue; }
    try {
      results.push(await pushToEtsy(env, sku, live.get(id) ?? 0));
    } catch (e) {
      await logEvent(env, "Etsy update failed", { sku, error: errMsg(e) });
      results.push({ sku, error: errMsg(e) });
    }
  }
  return results;
}

// ---------- Etsy -> Square ----------

export async function recordEtsyReceipt(env: Env, receipt: EtsyReceipt): Promise<ReceiptResult> {
  const receiptId = receipt.receipt_id;
  const doneKey = `etsy:receipt:${receiptId}`;
  if (await env.GC_KV.get(doneKey)) return { skipped: "already-recorded", receiptId };
  if (receipt.is_paid === false) return { skipped: "not-paid", receiptId };

  const dry = isTrue(env.SYNC_DRY_RUN);
  const skuMap = await getSquareSkuMap(env);
  const results: unknown[] = [];
  for (const t of receipt.transactions || []) {
    const sku = (t.sku || "").trim();
    if (!sku) { results.push({ txn: t.transaction_id, skipped: "no-sku", title: t.title }); continue; }
    let variationId: string | null | undefined = skuMap[sku];
    if (!variationId) {
      const v = await square.findVariationBySku(env, sku);
      variationId = v && v.id;
    }
    if (!variationId) { results.push({ sku, skipped: "not-in-square" }); continue; }
    const change = { variationId, quantity: Number(t.quantity) || 1, idempotencyKey: `etsy-${receiptId}-${t.transaction_id}` };
    if (dry) results.push({ sku, dryRun: true, ...change });
    else { await square.recordExternalSale(env, change); results.push({ sku, recorded: change.quantity }); }
  }
  if (!dry) await env.GC_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 45 });
  await logEvent(env, dry ? "DRY RUN: would record Etsy sale in Square" : "Recorded Etsy sale in Square", { receiptId, results });
  return { receiptId, results };
}

export async function handleEtsyEvent(env: Env, event: EtsyWebhookEvent) {
  if (event.event_type !== "order.paid") return { ignored: event.event_type };
  // resource_url points at the receipt; it includes the transactions with SKUs.
  const receipt = await etsyApi.etsy<EtsyReceipt>(env, event.resource_url);
  return recordEtsyReceipt(env, receipt);
}

// ---------- Hourly safety check ----------

export async function reconcile(env: Env, { maxChecks = 10 } = {}) {
  const report: ReconcileReport = { at: new Date().toISOString(), etsySalesChecked: 0, changed: [], notPublished: [], squareOnly: [], etsyOnly: [], errors: [] };
  let salesChecked = false;

  // 1. Catch any Etsy sales whose webhook never arrived (last 3 days).
  try {
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const receipts = await etsyApi.recentPaidReceipts(env, since);
    report.etsySalesChecked = receipts.length;
    for (const r of receipts) {
      try { await recordEtsyReceipt(env, r); } catch (e) { report.errors.push(`receipt ${r.receipt_id}: ${errMsg(e)}`); }
    }
    salesChecked = !report.errors.length;
  } catch (e) {
    report.errors.push(`receipts: ${errMsg(e)}`);
  }

  // 2. Fresh view of both sides.
  const { skuMap, counts, tracked: trackedIds } = await square.buildStorefront(env);
  await env.GC_KV.put("square:skumap", JSON.stringify({ at: Date.now(), map: skuMap }));
  const listings = await etsyApi.fetchShopListings(env);
  const etsyMap = (await refreshEtsySkuMap(env, listings)).map;

  report.squareOnly = Object.keys(skuMap).filter((s) => !etsyMap[s]).sort();
  // Only listings that are on sale: a sold-out or inactive one with no Square item is just a piece that's gone.
  const onSale = new Set(listings.filter((l) => l.state === "active").flatMap((l) => (l.skus || []).map((s) => s.trim()).filter(Boolean)));
  report.etsyOnly = [...onSale].filter((s) => !skuMap[s]).sort();

  // 3. Make Etsy's counts match Square's. A listing with one SKU shows its count in the list above;
  // one with several only shows a total, which can match while the variations don't, so its stock is read.
  const certain: { l: EtsyListing; want: Map<string, number> }[] = [];
  const maybe: typeof certain = [];
  for (const l of listings) {
    // Only compare SKUs whose stock Square actually counts; untracked items are left alone.
    const tracked = (l.skus || []).map((s) => s.trim()).filter((s) => skuMap[s] && trackedIds.has(skuMap[s]));
    if (!tracked.length) continue;
    const want = new Map(tracked.map((s) => [s, counts.get(skuMap[s]) ?? 0]));
    const squareTotal = [...want.values()].reduce((n, q) => n + q, 0);
    const active = l.state === "active";
    if (!active && squareTotal > 0) report.notPublished.push({ listing: l.listing_id, title: l.title, state: l.state, square: squareTotal });
    if (l.state === "sold_out" || (!active && squareTotal === 0)) continue; // nothing the sync would write
    if (squareTotal !== (Number(l.quantity) || 0)) certain.push({ l, want });
    else if ((l.skus || []).filter(Boolean).length > 1) maybe.push({ l, want });
  }
  // Each check is a request to Etsy and a run only gets so many. The ones that might be fine take turns.
  const turn = maybe.length ? Math.floor(Date.now() / 3600e3) % maybe.length : 0;
  const queue = [...certain, ...maybe.slice(turn), ...maybe.slice(0, turn)];
  if (certain.length > maxChecks) report.errors.push(`${certain.length - maxChecks} more listings need updating; they'll be done next run`);
  for (const { l, want } of queue.slice(0, maxChecks)) {
    try {
      for (const r of await syncListing(env, l, want, { allowRaise: salesChecked })) {
        if (r.updated || r.dryRun) report.changed.push({ sku: r.sku!, listing: l.listing_id, from: r.from, to: r.to, dryRun: !!r.dryRun });
      }
    } catch (e) { report.errors.push(`listing ${l.listing_id}: ${errMsg(e)}`); }
  }

  await env.GC_KV.put("status:last-reconcile", JSON.stringify(report));
  if (report.changed.length || report.errors.length) await logEvent(env, "Hourly check", { changed: report.changed, errors: report.errors });
  return report;
}
