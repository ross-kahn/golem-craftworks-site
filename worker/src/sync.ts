// Inventory sync. Square is the source of truth; Etsy follows it.
//
//   Square stock changes (in-person sale, website sale, manual edit)
//     -> Square webhook -> set the Etsy listing to match
//   Etsy sale
//     -> Etsy webhook (plus an hourly safety check) -> record the sale in Square
//
// Safety rules:
//   * Webhook handlers re-read live Square counts instead of trusting payload order.
//   * The hourly check only ever LOWERS Etsy stock. Raising Etsy stock (a restock) only
//     happens in response to a real Square change, so a missed Etsy webhook can't relist a sold piece.
//   * SYNC_DRY_RUN=true logs every change it would make without making it.

import * as square from "./square.ts";
import * as etsyApi from "./etsy.ts";
import { logEvent, isTrue, errMsg } from "./util.ts";
import type {
  Env, EtsyListing, EtsyOffering, EtsyReceipt, EtsyWebhookEvent,
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

/**
 * Make the Etsy listing that carries `sku` show `qty`.
 * allowRaise=false means only lower Etsy stock (used by the hourly check).
 */
export async function pushToEtsy(env: Env, sku: string, qty: number, { allowRaise = true } = {}): Promise<PushResult> {
  const dry = isTrue(env.SYNC_DRY_RUN);
  const listingId = await etsyListingForSku(env, sku);
  if (!listingId) return { skipped: "no-etsy-listing" };

  const [listing, inv] = await Promise.all([etsyApi.getListing(env, listingId), etsyApi.getInventory(env, listingId)]);
  const products = (inv.products || []).filter((p) => !p.is_deleted);
  const product = products.find((p) => (p.sku || "").trim() === sku);
  if (!product) return { skipped: "sku-not-on-listing" };
  const offering: Partial<EtsyOffering> = (product.offerings || []).find((o) => !o.is_deleted) || {};
  const active = listing.state === "active";
  const currentQty = active && offering.is_enabled !== false ? Number(offering.quantity) || 0 : 0;

  if (qty === currentQty && (qty > 0 ? active && offering.is_enabled !== false : true)) {
    return { unchanged: true };
  }
  if (qty > currentQty && !allowRaise) return { skipped: "raise-not-allowed" };

  // What's left sellable on the listing after this change?
  const remaining = products.reduce((n, p) => {
    if ((p.sku || "").trim() === sku) return n + qty;
    const o: Partial<EtsyOffering> = (p.offerings || []).find((x) => !x.is_deleted) || {};
    return n + (o.is_enabled === false ? 0 : Number(o.quantity) || 0);
  }, 0);

  const plan: { action: string; qty?: number }[] = [];
  if (qty === 0 && remaining === 0) {
    if (active) plan.push({ action: "deactivate-listing" });
  } else {
    plan.push({ action: "set-quantity", qty });
    if (!active && qty > 0) plan.push({ action: "activate-listing" });
  }
  if (!plan.length) return { unchanged: true };

  const summary = { sku, listingId, from: currentQty, to: qty, state: listing.state, plan: plan.map((p) => p.action) };
  if (dry) {
    await logEvent(env, "DRY RUN: would update Etsy", summary);
    return { dryRun: true, ...summary };
  }

  for (const step of plan) {
    if (step.action === "deactivate-listing") {
      await etsyApi.setListingState(env, listingId, "inactive");
    } else if (step.action === "set-quantity") {
      await etsyApi.putInventory(env, listingId, etsyApi.inventoryForPut(inv, new Map([[sku, qty]])));
    } else if (step.action === "activate-listing") {
      await etsyApi.setListingState(env, listingId, "active");
    }
  }
  await logEvent(env, "Updated Etsy to match Square", summary);
  return { updated: true, ...summary };
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
      results.push(await pushToEtsy(env, sku, live.get(id) ?? 0, { allowRaise: true }));
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

export async function reconcile(env: Env, { maxUpdates = 6 } = {}) {
  const report: ReconcileReport = { at: new Date().toISOString(), etsySalesChecked: 0, lowered: [], etsyLowerThanSquare: [], squareOnly: [], etsyOnly: [], errors: [] };

  // 1. Catch any Etsy sales whose webhook never arrived (last 3 days).
  try {
    const since = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const receipts = await etsyApi.recentPaidReceipts(env, since);
    report.etsySalesChecked = receipts.length;
    for (const r of receipts) {
      try { await recordEtsyReceipt(env, r); } catch (e) { report.errors.push(`receipt ${r.receipt_id}: ${errMsg(e)}`); }
    }
  } catch (e) {
    report.errors.push(`receipts: ${errMsg(e)}`);
  }

  // 2. Fresh view of both sides.
  const { skuMap, counts, tracked: trackedIds } = await square.buildStorefront(env);
  await env.GC_KV.put("square:skumap", JSON.stringify({ at: Date.now(), map: skuMap }));
  const listings = await etsyApi.fetchShopListings(env);
  const etsyMap = (await refreshEtsySkuMap(env, listings)).map;

  report.squareOnly = Object.keys(skuMap).filter((s) => !etsyMap[s]).sort();
  report.etsyOnly = Object.keys(etsyMap).filter((s) => !skuMap[s]).sort();

  // 3. Lower Etsy wherever it shows more than Square has.
  let updates = 0;
  for (const l of listings) {
    // Only compare SKUs whose stock Square actually counts; untracked items are left alone.
    const tracked = (l.skus || []).map((s) => s.trim()).filter((s) => skuMap[s] && trackedIds.has(skuMap[s]));
    if (!tracked.length) continue;
    const squareTotal = tracked.reduce((n, s) => n + (counts.get(skuMap[s]) ?? 0), 0);
    const etsyTotal = l.state === "active" ? Number(l.quantity) || 0 : 0;
    if (squareTotal < etsyTotal) {
      if (updates >= maxUpdates) { report.errors.push(`update limit reached; ${l.listing_id} will be checked next run`); continue; }
      for (const s of tracked) {
        try {
          const r = await pushToEtsy(env, s, counts.get(skuMap[s]) ?? 0, { allowRaise: false });
          if (r.updated || r.dryRun) report.lowered.push({ sku: s, listing: l.listing_id, to: r.to, dryRun: !!r.dryRun });
        } catch (e) { report.errors.push(`${s}: ${errMsg(e)}`); }
      }
      updates++;
    } else if (squareTotal > etsyTotal) {
      report.etsyLowerThanSquare.push({ listing: l.listing_id, title: l.title, etsy: etsyTotal, square: squareTotal, state: l.state });
    }
  }

  await env.GC_KV.put("status:last-reconcile", JSON.stringify(report));
  if (report.lowered.length || report.errors.length) await logEvent(env, "Hourly check", { lowered: report.lowered, errors: report.errors });
  return report;
}
