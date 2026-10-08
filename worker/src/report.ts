// Daily report: emails the shop when the sync has something that needs a look, from the same
// information as /admin/status. A day with nothing wrong sends nothing.

import { group } from "radashi";
import { mailReady, send } from "./email.ts";
import { logEvent, isTrue, errMsg, siteUrl } from "./util.ts";
import type {
  DraftReport,
  Env,
  EtsyTokens,
  LogLine,
  ReconcileReport,
} from "./types.ts";

const DAY_MS = 24 * 3600 * 1000;
const STALE_MS = 3 * 3600 * 1000; // the check runs hourly: three hours without one means it's stuck
const SEEN_KEY = "status:report-skus";
// The activity log has no levels; these are the words its failure lines use.
const FAILURE =
  /fail|didn't|couldn't|without the catalog|isn't set up|no notification/i;

interface SeenSkus {
  squareOnly: string[];
  etsyOnly: string[];
}

export async function dailyReport(env: Env) {
  const [last, drafts, log, tokens, seen] = await Promise.all([
    env.GC_KV.get<ReconcileReport>("status:last-reconcile", "json"),
    env.GC_KV.get<DraftReport>("status:last-drafts", "json"),
    env.GC_KV.get<LogLine[]>("log", "json"),
    env.GC_KV.get<EtsyTokens>("etsy:tokens", "json"),
    env.GC_KV.get<SeenSkus>(SEEN_KEY, "json"),
  ]);

  const sections: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length)
      sections.push([title, ...lines.map((l) => `  - ${l}`)].join("\n"));
  };

  if (!tokens)
    section("Etsy isn't connected", [
      "Nothing syncs with Etsy until you sign in again at /admin/etsy/connect.",
    ]);
  if (isTrue(env.SYNC_DRY_RUN))
    section("The sync is in dry-run mode", [
      "It's logging what it would change without changing anything (SYNC_DRY_RUN in wrangler.toml).",
    ]);
  if (!last || Date.now() - Date.parse(last.at) > STALE_MS) {
    section("The hourly check hasn't run lately", [
      last ? `It last ran at ${last.at}.` : "It has never run.",
    ]);
  }
  if (last) {
    section("Errors in the last hourly check", last.errors || []);
    section(
      "Back in stock in Square, waiting for you to publish on Etsy",
      (last.notPublished || []).map(
        (n) =>
          `${n.title || `Listing ${n.listing}`}: ${n.square} in Square, ${n.state === "sold_out" ? "Sold out" : "Inactive"} on Etsy`,
      ),
    );
  }
  section("Problems making Etsy drafts", drafts?.errors || []);

  // SKUs on one side only are often on purpose, so each is reported once, when it first shows up.
  const now: SeenSkus = {
    squareOnly: last?.squareOnly || [],
    etsyOnly: last?.etsyOnly || [],
  };
  const fresh = (key: keyof SeenSkus) =>
    now[key].filter((s) => !(seen?.[key] || []).includes(s));
  section(
    "New SKUs on Etsy with no match in Square (their stock isn't synced; check the spelling and capitals)",
    fresh("etsyOnly"),
  );
  section(
    "New SKUs in Square with no match on Etsy (fine if they aren't meant to be on Etsy)",
    fresh("squareOnly"),
  );

  // The same failure every hour is one line, not twenty-four.
  const failures = group(
    (log || []).filter(
      (l) => FAILURE.test(l.message) && Date.now() - Date.parse(l.at) < DAY_MS,
    ),
    (l) => l.message,
  );
  section(
    "Failures in the last day",
    Object.entries(failures).map(([message, lines = []]) => {
      const [latest] = lines; // the log is newest first
      const n = lines.length;
      const error = (latest.data as { error?: string } | undefined)?.error;
      return `${message}${n > 1 ? ` (${n} times)` : ""}${error ? `: ${error}` : ""} [${latest.at}]`;
    }),
  );

  if (!sections.length) return { sent: false, sections };
  if (!mailReady(env)) {
    await logEvent(
      env,
      "The daily report had something to say, but email isn't set up",
      { sections: sections.length },
    );
    return { sent: false, sections };
  }
  const shop = env.SALES_TO || env.COMMISSION_TO;
  try {
    await send(env, {
      from: env.EMAIL_FROM,
      to: [shop],
      reply_to: shop,
      subject: `Golem Craftworks sync: ${sections.length} ${sections.length === 1 ? "thing needs" : "things need"} a look`,
      text: `${sections.join("\n\n")}\n\n--\nThe full picture is at ${siteUrl(env)}/admin/status?token=YOUR_ADMIN_TOKEN\nThis is sent once a day, and only when there's something to report.`,
    });
  } catch (e) {
    await logEvent(env, "Daily report email failed", { error: errMsg(e) });
    return { sent: false, sections };
  }
  await env.GC_KV.put(SEEN_KEY, JSON.stringify(now));
  return { sent: true, sections };
}
