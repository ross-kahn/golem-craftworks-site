// Small helpers shared across the Worker.
import type { Env, LogLine } from "./types.ts";

export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export function corsHeaders(
  env: Env,
  request: Request,
): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || env.SITE_URL || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  const ok = allowed.includes(origin) || allowed.includes("*");
  return ok
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : { vary: "origin" };
}

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

// `"JAVA" TTRPG Dice Set` -> `java-ttrpg-dice-set`
export const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f'’"]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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
