#!/usr/bin/env node
// One-time helper: cut every dice set's description in Square down to what's particular to that set.
// The wording the sets share now lives in worker/src/descriptions.ts, and the site puts the two together.
//
//   * Only items named like a dice set are touched: "JAVA" TTRPG Dice Set.
//   * Lines that match the template (or an older wording of it) are removed. What's left stays.
//   * A leftover line that shows up on several sets is kept only on the set it names.
//   * A set with nothing of its own ends up with an empty description.
//
// Safe to run twice. Dry run unless you pass --apply: read the preview first, it shows exactly
// what each set keeps.
//
// Usage:
//   SQUARE_ACCESS_TOKEN=xxx node tools/clear-dice-descriptions.ts            # preview
//   SQUARE_ACCESS_TOKEN=xxx node tools/clear-dice-descriptions.ts --apply
// Options: --sandbox

import { randomUUID } from "node:crypto";
import { cluster } from "radashi";
import {
  squareClient,
  searchCatalog,
  postJSON,
  descriptionHtml,
} from "./shared.ts";
import { planNotes } from "./dice-notes.ts";
import { squareDescription } from "../worker/src/descriptions.ts";

// Catalog objects are sent back whole when updated, so fields this script doesn't use are kept as they came.
interface CatalogObject {
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    description_plaintext?: string;
    description_html?: string;
    [field: string]: unknown;
  };
  [field: string]: unknown;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error(
    "Usage: SQUARE_ACCESS_TOKEN=... node tools/clear-dice-descriptions.ts [--apply]",
  );
  process.exit(1);
}

const sq = squareClient({ token: TOKEN, sandbox: args.includes("--sandbox") });

const items = await searchCatalog<CatalogObject>(sq, "ITEM");

const byId = new Map(items.map((i) => [i.id, i]));
const plan = planNotes(
  items.map((i) => ({
    id: i.id,
    name: i.item_data?.name || "",
    description: squareDescription(i.item_data || {}),
  })),
);
const changes = plan.filter((s) => s.changed);

console.log(
  `${plan.length} dice set(s) in Square, ${changes.length} to trim.\n`,
);
for (const s of plan) {
  console.log(`${s.name}${s.changed ? "" : "  (already trimmed)"}`);
  console.log(
    s.notes
      ? s.notes
          .split("\n")
          .map((l) => `   ${l}`)
          .join("\n")
      : "   (nothing of its own: the description will be empty)",
  );
  s.copied.forEach((l) =>
    console.log(`   dropped, belongs to another set: ${l}`),
  );
  console.log("");
}

if (APPLY && changes.length) {
  const objects = changes.map((s) => {
    const item = byId.get(s.id)!;
    const {
      description: _old,
      description_plaintext: _derived,
      description_html: _html,
      ...data
    } = item.item_data || {};
    return {
      ...item,
      item_data: {
        ...data,
        ...(s.notes ? { description_html: descriptionHtml(s.notes) } : {}),
      },
    };
  });
  for (const batch of cluster(objects, 20)) {
    await sq(
      "/v2/catalog/batch-upsert",
      postJSON({
        idempotency_key: randomUUID(),
        batches: [{ objects: batch }],
      }),
    );
  }
  console.log(`Trimmed ${changes.length} description(s).`);
} else {
  console.log(
    `${changes.length} to trim.${APPLY ? "" : " This was a preview. Run again with --apply to make the changes."}`,
  );
}
