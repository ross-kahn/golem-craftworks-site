// Commission requests: emails the request to the shop and a confirmation to the client (via Resend).

import { json, logEvent, errMsg } from "./util.ts";
import type { Env } from "./types.ts";

const RESEND_URL = "https://api.resend.com/emails";
const TYPES = ["Dice vault", "Game set or box", "Dice", "Engraving on an existing design", "Something else"];
const LIMITS = { name: 100, email: 254, idea: 4000, when: 200, budget: 200 };
const MAX_PER_HOUR = 5;

// Stricter than the browser check: one @, no spaces, a dotted domain with a 2+ letter ending.
const EMAIL_RE = /^[^\s@<>(),;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

export interface CommissionData {
  name: string;
  email: string;
  type: string;
  idea: string;
  when: string;
  budget: string;
}

interface Email {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
}

// An Env with the email settings filled in.
export type MailEnv = Env & Required<Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM" | "COMMISSION_TO">>;
export const mailReady = (env: Env): env is MailEnv => !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.COMMISSION_TO);

export const isEmail = (s: unknown): s is string =>
  typeof s === "string" && s.length <= LIMITS.email && EMAIL_RE.test(s) && !s.includes("..");

const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);

export function parseCommission(body: unknown) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data: CommissionData = {
    name: oneLine(b.name, LIMITS.name),
    email: oneLine(b.email, LIMITS.email),
    type: typeof b.type === "string" && TYPES.includes(b.type) ? b.type : "Something else",
    idea: String(b.idea ?? "").trim().slice(0, LIMITS.idea),
    when: oneLine(b.when, LIMITS.when),
    budget: oneLine(b.budget, LIMITS.budget)
  };
  const missing: string[] = [];
  if (!data.name) missing.push("your name");
  if (!isEmail(data.email)) missing.push("a valid email");
  if (!data.idea) missing.push("a description of your idea");
  return { data, missing };
}

function summary(d: CommissionData) {
  return [
    `Name: ${d.name}`,
    `Email: ${d.email}`,
    `Type: ${d.type}`,
    d.when ? `Needed by: ${d.when}` : "",
    d.budget ? `Budget: ${d.budget}` : "",
    "",
    d.idea
  ].filter((l, i) => l !== "" || i === 5).join("\n");
}

export function buildEmails(env: MailEnv, d: CommissionData): { shop: Email; client: Email } {
  const shop = env.COMMISSION_TO;
  return {
    shop: {
      from: env.EMAIL_FROM,
      to: [shop],
      reply_to: d.email,
      subject: `New commission request: ${d.type} (${d.name})`,
      text: `${summary(d)}\n\n--\nReply to this email to answer ${d.name} directly.`
    },
    client: {
      from: env.EMAIL_FROM,
      to: [d.email],
      reply_to: shop,
      subject: "Golem Craftworks received your commission request",
      text:
        `Hi ${d.name},\n\n` +
        `Thanks for your commission request. I've got it and will reply to this address shortly.\n\n` +
        `Here's a copy of what you sent:\n\n${summary(d)}\n\n` +
        `If anything needs changing, just reply to this email.\n\n` +
        `Golem Craftworks\n${env.SITE_URL || ""}`
    }
  };
}

export async function send(env: MailEnv, message: Email) {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(message)
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Each request emails an address the visitor typed, so cap how many one visitor can send.
async function overLimit(env: Env, request: Request) {
  if (!env.GC_KV) return false;
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `commission:rate:${ip}:${Math.floor(Date.now() / 3600000)}`;
  const n = Number(await env.GC_KV.get(key)) || 0;
  if (n >= MAX_PER_HOUR) return true;
  await env.GC_KV.put(key, String(n + 1), { expirationTtl: 60 * 60 * 2 });
  return false;
}

export async function commission(request: Request, env: Env) {
  let body: Record<string, unknown> | null;
  try { body = (await request.json()) as Record<string, unknown> | null; } catch { return json({ error: "Invalid request." }, 400); }

  // Hidden field real visitors never fill in. Pretend it worked so bots don't retry.
  if (body && body.website) return json({ ok: true, confirmationSent: true });

  const { data, missing } = parseCommission(body);
  if (missing.length) return json({ error: `Add ${missing.join(", ")} to send the request.`, missing }, 400);

  if (!mailReady(env)) {
    await logEvent(env, "Commission email is not set up (RESEND_API_KEY, EMAIL_FROM, COMMISSION_TO)");
    return json({ error: "The form can't send right now. Email me directly instead." }, 503);
  }
  if (await overLimit(env, request)) {
    return json({ error: "That's a lot of requests in a short time. Try again in an hour, or email me directly." }, 429);
  }

  const emails = buildEmails(env, data);
  try {
    await send(env, emails.shop);
  } catch (e) {
    await logEvent(env, "Commission request failed to send", { error: errMsg(e) });
    return json({ error: "The request didn't send. Try again, or email me directly." }, 502);
  }

  // The shop has the request at this point, so a failed confirmation isn't a failed request.
  let confirmationSent = true;
  try {
    await send(env, emails.client);
  } catch (e) {
    confirmationSent = false;
    await logEvent(env, "Commission confirmation to client failed", { to: data.email, error: errMsg(e) });
  }
  return json({ ok: true, confirmationSent });
}
