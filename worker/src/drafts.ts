// Etsy drafts for new dice sets. Square is where a set is added; this gives it an Etsy listing.
//
//   A Square item in one of ETSY_DRAFT_CATEGORIES, in stock, whose SKU is on no Etsy listing
//     -> a new Etsy draft: settings copied from the draft whose title starts with "TEMPLATE",
//        with this set's name, description, price, stock, SKU and photos.
//
// It runs right after any change Square reports (index.ts), and hourly in case one was missed.
//
// Safety rules:
//   * Only the categories named in ETSY_DRAFT_CATEGORIES. Nothing else is ever listed for you.
//   * One draft per SKU, ever: each one made is remembered, so deleting a draft on Etsy doesn't bring it back.
//   * Drafts stay drafts (no Etsy fee) unless ETSY_DRAFTS_AUTO_PUBLISH is "true".
//   * SYNC_DRY_RUN=true reports what it would create without creating it.
//   * The stock sync (sync.ts) doesn't look at drafts, so nothing else can publish one.
//
// It also keeps photos in step for the same categories, drafts and published listings alike:
// when an item's photos change in Square, its Etsy listing's photos are replaced with them.

import * as square from "./square.ts";
import * as etsyApi from "./etsy.ts";
import { decodeEntities, diceSetName } from "./descriptions.ts";
import { getEtsySkuMap } from "./sync.ts";
import { logEvent, isTrue, errMsg } from "./util.ts";
import type { DraftReport, Env, EtsyListing } from "./types.ts";

const DRAFTED_KEY = "etsy:drafted"; // sku -> the listing made for it
const PHOTOS_KEY = "etsy:photos"; // sku -> the Square photos Etsy was last given
const MAX_PHOTOS = 10;
const TITLE_MAX = 140; // Etsy's limit
// A listing in any of these states already carries its SKU, so that SKU gets no draft.
const EVERY_STATE = ["active", "inactive", "sold_out", "draft", "expired"];
// What a new draft takes from the template as it stands. Etsy sends back the same names it accepts.
const COPIED = [
  "who_made",
  "when_made",
  "taxonomy_id",
  "shipping_profile_id",
  "return_policy_id",
  "shop_section_id",
  "tags",
  "materials",
  "is_supply",
  "should_auto_renew",
  "processing_min",
  "processing_max",
  "item_weight",
  "item_weight_unit",
  "item_length",
  "item_width",
  "item_height",
  "item_dimensions_unit",
] as const;

const csv = (s?: string) =>
  (s || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

// `TEMPLATE 8-Piece Dice Set | Handmade…` -> `JAVA 8-Piece Dice Set | Handmade…`
export const draftTitle = (templateTitle: string, name: string) =>
  decodeEntities(templateTitle)
    .trim()
    .replace(/^TEMPLATE/i, () => name)
    .slice(0, TITLE_MAX)
    .trim();

function draftForm(
  template: EtsyListing,
  fields: {
    title: string;
    description: string;
    priceCents: number;
    qty: number;
    readiness?: number;
  },
) {
  const form: Record<string, string> = {
    title: fields.title,
    description: fields.description,
    price: (fields.priceCents / 100).toFixed(2),
    quantity: String(fields.qty),
    type: "physical",
  };
  for (const key of COPIED) {
    const v = template[key];
    if (
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && !v.length)
    )
      continue;
    form[key] = Array.isArray(v)
      ? v.map((x) => decodeEntities(x)).join(",")
      : String(v);
  }
  if (fields.readiness) form.readiness_state_id = String(fields.readiness);
  return form;
}

/**
 * Create drafts for new dice sets, then bring Etsy's photos up to date for any set whose Square
 * photos changed. `budget` is how many requests this run may spend: a Worker gets a limited
 * number per run, and each photo costs two (fetch it, send it). What doesn't fit waits for the next run.
 *
 * `quick` is for the run that follows every change in Square: it first checks against what's
 * already on file, and stops there (no Etsy requests, nothing saved) unless something looks new.
 */
export async function createEtsyDrafts(
  env: Env,
  { budget = 30, quick = false } = {},
): Promise<DraftReport> {
  const dry = isTrue(env.SYNC_DRY_RUN);
  const publish = isTrue(env.ETSY_DRAFTS_AUTO_PUBLISH);
  const report: DraftReport = {
    at: new Date().toISOString(),
    dryRun: dry,
    created: [],
    waiting: [],
    photosUpdated: [],
    photosWaiting: [],
    errors: [],
  };
  const categories = csv(env.ETSY_DRAFT_CATEGORIES);
  if (!categories.length) return report;

  const { products } = await square.buildStorefront(env);
  const drafted =
    (await env.GC_KV.get<Record<string, number>>(DRAFTED_KEY, "json")) || {};
  const sent =
    (await env.GC_KV.get<Record<string, string>>(PHOTOS_KEY, "json")) || {};
  let sentChanged = false;
  const noted = (sku: string, photos: string) => {
    sent[sku] = photos;
    sentChanged = true;
  };

  // Every item this looks after: in a named category, with one SKU.
  const sets = products.flatMap((p) => {
    const v = p.variations[0];
    const sku = (v.sku || "").trim();
    return categories.includes(p.category.toLowerCase()) &&
      p.variations.length === 1 &&
      sku
      ? [
          {
            p,
            sku,
            name: diceSetName(p.name),
            priceCents: v.priceCents,
            qty: v.qty,
            photos: p.images.slice(0, MAX_PHOTOS),
          },
        ]
      : [];
  });

  // New: stock counted in Square, at least one to sell, and nothing on Etsy for it yet.
  // `named` picks the ones named like a dice set, or the ones that aren't.
  const newSets = (onEtsy: Record<string, number>, named = true) =>
    sets.filter(
      (s) => !!s.qty && !!s.name === named && !onEtsy[s.sku] && !drafted[s.sku],
    );

  // Photos changed in Square since Etsy was last given them. A set seen for the first time is
  // taken to match: its Etsy photos are left as they are until Square's next change.
  const stale = sets.filter((s) => {
    const now = s.photos.join("\n");
    if (sent[s.sku] === undefined) {
      noted(s.sku, now);
      return false;
    }
    return sent[s.sku] !== now && s.photos.length > 0; // never strips a listing of every photo
  });

  let onEtsy = quick ? (await getEtsySkuMap(env)).map : {};
  const saveNotes = async () => {
    if (sentChanged) await env.GC_KV.put(PHOTOS_KEY, JSON.stringify(sent));
  };
  if (quick && !newSets(onEtsy).length) {
    if (!stale.length) {
      await saveNotes();
      return report;
    }
  } else {
    const listings = await etsyApi.fetchShopListings(env, EVERY_STATE);
    onEtsy = etsyApi.buildEtsySkuMap(listings);
    await makeDrafts(listings);
  }
  await updatePhotos();
  await saveNotes();
  await env.GC_KV.put("status:last-drafts", JSON.stringify(report));
  return report;

  async function makeDrafts(listings: EtsyListing[]) {
    // A name like `"JAVA" TTRPG Dice Set Copy` is an item that isn't finished: its title and shared
    // description both hang on the name. It gets its draft once it's renamed.
    newSets(onEtsy, false).forEach((c) =>
      report.errors.push(
        `${c.sku}: no draft, because '${c.p.name}' isn't named like '"NAME" TTRPG Dice Set'. Rename it in Square.`,
      ),
    );
    const candidates = newSets(onEtsy);
    if (!candidates.length) return;

    const template = listings.find(
      (l) => l.state === "draft" && /^\s*TEMPLATE/i.test(l.title || ""),
    );
    if (!template) {
      report.waiting = candidates.map((c) => c.sku);
      report.errors.push(
        `No Etsy draft with a title starting "TEMPLATE" to copy settings from.`,
      );
      return;
    }

    if (dry) {
      report.waiting = candidates.map((c) => c.sku);
      // Said once per change in what's waiting, not every hour.
      const seen = report.waiting.join(",");
      if ((await env.GC_KV.get("etsy:drafts:dry")) !== seen) {
        await env.GC_KV.put("etsy:drafts:dry", seen);
        await logEvent(env, "DRY RUN: would create Etsy drafts", {
          sets: candidates.map((c) => ({
            sku: c.sku,
            title: draftTitle(template.title || "", c.name!),
            photos: c.photos.length,
          })),
        });
      }
      return;
    }

    // How soon it ships is set on the template's stock line, not on the listing itself.
    const templateStock = await etsyApi.getInventory(env, template.listing_id);
    const readiness =
      templateStock.products?.[0]?.offerings?.[0]?.readiness_state_id;
    budget -= 1;

    for (const { p, sku, name, priceCents, photos, ...set } of candidates) {
      const qty = set.qty as number;
      const cost = 2 + 2 * photos.length + (publish ? 1 : 0);
      if (cost > budget) {
        report.waiting.push(sku);
        continue;
      }
      // Two runs can start seconds apart (Square reports a new item and its stock separately): the first one takes the set.
      if (!(await claim(`etsy:drafting:${sku}`))) {
        report.waiting.push(sku);
        continue;
      }
      budget -= cost;
      const title = draftTitle(template.title || "", name!);
      try {
        const listing = await etsyApi.createDraftListing(
          env,
          draftForm(template, {
            title,
            description: p.description,
            priceCents,
            qty,
            readiness,
          }),
        );
        const listingId = listing.listing_id;
        drafted[sku] = listingId;
        await env.GC_KV.put(DRAFTED_KEY, JSON.stringify(drafted));
        noted(sku, photos.join("\n"));

        // From here on the draft exists: anything that fails is reported, and finished by hand on Etsy.
        const problems: string[] = [];
        try {
          await etsyApi.putInventory(env, listingId, {
            products: [
              {
                sku,
                property_values: [],
                offerings: [
                  {
                    price: priceCents / 100,
                    quantity: qty,
                    is_enabled: true,
                    ...(readiness ? { readiness_state_id: readiness } : {}),
                  },
                ],
              },
            ],
            price_on_property: [],
            quantity_on_property: [],
            sku_on_property: [],
          });
        } catch (e) {
          problems.push(`SKU not set: ${errMsg(e)}`);
        }

        const sentPhotos = await sendPhotos(listingId, photos, problems);

        // Etsy won't publish a listing without a photo, and a half-made one shouldn't go out.
        let published = false;
        if (publish && sentPhotos > 0 && !problems.length) {
          try {
            await etsyApi.setListingState(env, listingId, "active");
            published = true;
          } catch (e) {
            problems.push(`not published: ${errMsg(e)}`);
          }
        }

        report.created.push({
          sku,
          listingId,
          title,
          photos: sentPhotos,
          published,
        });
        problems.forEach((m) =>
          report.errors.push(`${sku} (listing ${listingId}): ${m}`),
        );
        await logEvent(
          env,
          published
            ? "Created and published Etsy listing"
            : "Created Etsy draft",
          {
            sku,
            listingId,
            title,
            photos: sentPhotos,
            ...(problems.length ? { problems } : {}),
          },
        );
      } catch (e) {
        report.errors.push(`${sku}: ${errMsg(e)}`);
        await logEvent(env, "Etsy draft failed", { sku, error: errMsg(e) });
      }
    }
  }

  // Square's photos replace Etsy's, in Square's order. Whatever was changed by hand on Etsy goes.
  async function updatePhotos() {
    for (const { sku, photos } of stale) {
      const now = photos.join("\n");
      const listingId = drafted[sku] ?? onEtsy[sku];
      if (!listingId) {
        noted(sku, now);
        continue;
      } // nothing on Etsy to update; a draft made later starts from these
      const cost = 2 + 2 * photos.length; // removing the old ones comes on top: at most Etsy's photo limit
      if (dry || cost > budget) {
        report.photosWaiting.push(sku);
        continue;
      }
      if (!(await claim(`etsy:photos:${sku}`))) {
        report.photosWaiting.push(sku);
        continue;
      }
      budget -= cost;
      try {
        const before = new Set(
          (await etsyApi.getListingImages(env, listingId)).map(
            (i) => i.listing_image_id,
          ),
        );
        const problems: string[] = [];
        // New ones go in first, each taking the place of the photo at its position, so the listing is never without one.
        const n = await sendPhotos(listingId, photos, problems, true);
        if (problems.length) {
          problems.forEach((m) =>
            report.errors.push(`${sku} (listing ${listingId}): ${m}`),
          ); // tried again next run
          continue;
        }
        for (const img of await etsyApi.getListingImages(env, listingId)) {
          if (before.has(img.listing_image_id))
            await etsyApi.deleteListingImage(
              env,
              listingId,
              img.listing_image_id,
            );
        }
        noted(sku, now);
        report.photosUpdated.push({ sku, listingId, photos: n });
        await logEvent(env, "Updated Etsy photos to match Square", {
          sku,
          listingId,
          photos: n,
        });
      } catch (e) {
        report.errors.push(
          `${sku} (listing ${listingId}): photos not updated: ${errMsg(e)}`,
        );
        if (/\(404\)/.test(errMsg(e))) noted(sku, now); // the listing is gone from Etsy: stop trying
      } finally {
        await env.GC_KV.delete(`etsy:photos:${sku}`); // done: a later change can go straight ahead
      }
    }
  }

  async function sendPhotos(
    listingId: number,
    photos: string[],
    problems: string[],
    overwrite = false,
  ) {
    let n = 0;
    for (const [i, src] of photos.entries()) {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`photo fetch failed (${res.status})`);
        await etsyApi.uploadListingImage(
          env,
          listingId,
          await res.blob(),
          i + 1,
          overwrite,
        );
        n++;
      } catch (e) {
        problems.push(`photo ${i + 1}: ${errMsg(e)}`);
      }
    }
    return n;
  }

  // True for the first run to ask; another run asking in the next two minutes is told no.
  async function claim(key: string) {
    if (await env.GC_KV.get(key)) return false;
    await env.GC_KV.put(key, "1", { expirationTtl: 120 });
    return true;
  }
}
