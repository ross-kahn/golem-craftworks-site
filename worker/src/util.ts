// Small helpers shared across the Worker.
import type { Env, LogLine } from "./types.ts";
import { withoutSlash } from "../../shared/text.ts";

export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const enc = new TextEncoder();

export async function hmacSha256Base64(keyBytes: Uint8Array, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToBase64(new Uint8Array(sig));
}

export function bytesToBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function base64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Constant-time-ish string comparison for signatures.
export function safeEqual(a: unknown, b: unknown) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const enc8 = (s: string) => enc.encode(s);

export const isTrue = (v: unknown) => String(v || "").toLowerCase() === "true";

// The site's own address, without a slash on the end. `url` is the request, for when SITE_URL isn't set.
export const siteUrl = (env: Env, url?: URL) =>
  withoutSlash(env.SITE_URL || url?.origin || "");

// A bare page for the admin addresses, which stand apart from the site and its stylesheet.
const ADMIN_STYLE =
  "body{font:17px/1.5 system-ui;padding:32px;max-width:60ch;margin:auto}" +
  ".review-text{white-space:pre-line}" +
  ".review-photo{display:block;max-width:100%;margin:0 0 12px}" +
  ".action{display:inline}" +
  ".action button{font:inherit;padding:8px 16px;margin-right:8px}";
export const adminPage = (title: string, body: string, status = 200) =>
  new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex">` +
      `<title>${title}</title><style>${ADMIN_STYLE}</style><body>${body}</body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

// Admin addresses carry ?token=ADMIN_TOKEN. With no token set, nothing gets in.
export const isAdmin = (env: Env, url: URL) =>
  !!env.ADMIN_TOKEN &&
  safeEqual(url.searchParams.get("token") || "", env.ADMIN_TOKEN);

export const visitorIp = (request: Request) =>
  request.headers.get("cf-connecting-ip") || "";

export const errMsg = (e: unknown) =>
  e instanceof Error ? e.message : String(e);

// Append a line to a short rolling activity log in KV, visible at /admin/status.
export async function logEvent(env: Env, message: string, data?: unknown) {
  const line: LogLine = {
    at: new Date().toISOString(),
    message,
    ...(data ? { data } : {}),
  };
  console.log(JSON.stringify(line));
  if (!env.GC_KV) return;
  try {
    const log = (await env.GC_KV.get<LogLine[]>("log", "json")) || [];
    log.unshift(line);
    await env.GC_KV.put("log", JSON.stringify(log.slice(0, 60)));
  } catch (e) {
    console.log("log write failed", errMsg(e));
  }
}

// True for the first to ask; anyone asking again within `ttl` seconds is told no.
// For work that two runs seconds apart shouldn't both do.
export async function claim(env: Env, key: string, ttl: number) {
  if (await env.GC_KV.get(key)) return false;
  await env.GC_KV.put(key, "1", { expirationTtl: ttl });
  return true;
}

// Counts this request against each [key, most allowed]. True, with nothing counted, if any is already full.
// The counts are forgotten after `ttl` seconds.
export async function overLimit(
  env: Env,
  limits: (readonly [key: string, max: number])[],
  ttl: number,
) {
  if (!env.GC_KV) return false;
  const counts = await Promise.all(
    limits.map(async ([key]) => Number(await env.GC_KV.get(key)) || 0),
  );
  if (counts.some((n, i) => n >= limits[i][1])) return true;
  await Promise.all(
    limits.map(([key], i) =>
      env.GC_KV.put(key, String(counts[i] + 1), { expirationTtl: ttl }),
    ),
  );
  return false;
}
