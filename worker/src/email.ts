// Sending email through Resend (https://resend.com).
import type { Env } from "./types.ts";

const RESEND_URL = "https://api.resend.com/emails";

export interface Email {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
}

// An Env with the email settings filled in.
export type MailEnv = Env &
  Required<Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM" | "COMMISSION_TO">>;
export const mailReady = (env: Env): env is MailEnv =>
  !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.COMMISSION_TO);

export async function send(env: MailEnv, message: Email) {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });
  if (!res.ok)
    throw new Error(
      `Resend ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
}
