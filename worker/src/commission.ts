// Commission requests: emails the request to the shop and a confirmation to the client (via Resend).

import { json, logEvent, errMsg, overLimit, visitorIp } from "./util.ts";
import { mailReady, send } from "./email.ts";
import type { Email, MailEnv } from "./email.ts";
import { check } from "../../shared/validate.ts";
import { Commission } from "../../shared/forms.ts";
import type { CommissionData } from "../../shared/forms.ts";
import type { Env } from "./types.ts";

const MAX_PER_HOUR = 5;

export const parseCommission = (body: unknown) => check(Commission, body);

function summary(d: CommissionData) {
  return [
    `Name: ${d.name}`,
    `Email: ${d.email}`,
    `Type: ${d.type}`,
    d.when ? `Needed by: ${d.when}` : "",
    d.budget ? `Budget: ${d.budget}` : "",
    "",
    d.idea,
  ]
    .filter((l, i) => l !== "" || i === 5)
    .join("\n");
}

export function buildEmails(
  env: MailEnv,
  d: CommissionData,
): { shop: Email; client: Email } {
  const shop = env.COMMISSION_TO;
  return {
    shop: {
      from: env.EMAIL_FROM,
      to: [shop],
      reply_to: d.email,
      subject: `New commission request: ${d.type} (${d.name})`,
      text: `${summary(d)}\n\n--\nReply to this email to answer ${d.name} directly.`,
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
        `Golem Craftworks\n${env.SITE_URL || ""}`,
    },
  };
}

export async function commission(request: Request, env: Env) {
  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown> | null;
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // Hidden field real visitors never fill in. Pretend it worked so bots don't retry.
  if (body && body.website) return json({ ok: true, confirmationSent: true });

  const { data, missing } = parseCommission(body);
  if (missing.length)
    return json(
      { error: `Add ${missing.join(", ")} to send the request.`, missing },
      400,
    );

  if (!mailReady(env)) {
    await logEvent(
      env,
      "Commission email is not set up (RESEND_API_KEY, EMAIL_FROM, COMMISSION_TO)",
    );
    return json(
      { error: "The form can't send right now. Email me directly instead." },
      503,
    );
  }
  // Each request emails an address the visitor typed, so cap how many one visitor can send.
  const hour = Math.floor(Date.now() / 3600000);
  const rateKey = `commission:rate:${visitorIp(request) || "unknown"}:${hour}`;
  if (await overLimit(env, [[rateKey, MAX_PER_HOUR]], 2 * 3600)) {
    return json(
      {
        error:
          "That's a lot of requests in a short time. Try again in an hour, or email me directly.",
      },
      429,
    );
  }

  const emails = buildEmails(env, data);
  try {
    await send(env, emails.shop);
  } catch (e) {
    await logEvent(env, "Commission request failed to send", {
      error: errMsg(e),
    });
    return json(
      { error: "The request didn't send. Try again, or email me directly." },
      502,
    );
  }

  // The shop has the request at this point, so a failed confirmation isn't a failed request.
  let confirmationSent = true;
  try {
    await send(env, emails.client);
  } catch (e) {
    confirmationSent = false;
    await logEvent(env, "Commission confirmation to client failed", {
      to: data.email,
      error: errMsg(e),
    });
  }
  return json({ ok: true, confirmationSent });
}
