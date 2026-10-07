// Website sales: emails the shop when the payment for a website order goes through.
// Square emails the buyer their receipt; this is the shop's copy, with what to pack, where to send it and the money.

import * as square from "./square.ts";
import { mailReady, send } from "./commission.ts";
import { logEvent } from "./util.ts";
import type { Env, SquareAddress, SquareMoney, SquareWebhookEvent } from "./types.ts";

interface Order {
  line_items?: {
    name?: string; variation_name?: string; quantity?: string; note?: string;
    modifiers?: { name?: string }[]; gross_sales_money?: SquareMoney; total_money?: SquareMoney;
  }[];
  fulfillments?: { shipment_details?: { recipient?: { display_name?: string; email_address?: string; phone_number?: string; address?: SquareAddress } } }[];
  service_charges?: { name?: string; amount_money?: SquareMoney }[]; // the shipping fee
  discounts?: { name?: string; applied_money?: SquareMoney }[];
  total_tax_money?: SquareMoney;
  total_money?: SquareMoney;
}

const cents = (m?: SquareMoney) => m?.amount || 0;
const usd = (n: number) => `${n < 0 ? "-" : ""}$${(Math.abs(n) / 100).toFixed(2)}`;
const row = (label: string, n: number) => `${(label + ":").padEnd(14)}${usd(n)}`;

function addressLines(a?: SquareAddress) {
  if (!a) return [];
  return [
    a.address_line_1, a.address_line_2, a.address_line_3,
    [[a.locality, a.administrative_district_level_1].filter(Boolean).join(", "), a.postal_code].filter(Boolean).join(" "),
    a.country && a.country !== "US" ? a.country : ""
  ].filter(Boolean) as string[];
}

// Called for Square's payment events. Throws if the email can't be sent, so Square sends the event again.
export async function notifySale(env: Env, event: SquareWebhookEvent) {
  const p = event.data?.object?.payment;
  // In-person sales don't need an email: only orders that came through the site's checkout.
  if (!p || p.status !== "COMPLETED" || !p.order_id || !(p.note || "").startsWith(square.WEBSITE_ORDER_NOTE)) return;
  const doneKey = `sale:mailed:${p.order_id}`;
  if (await env.GC_KV.get(doneKey)) return; // Square reports a payment more than once
  if (!mailReady(env)) {
    await logEvent(env, "A website order came in, but email isn't set up so no notification was sent", { order: p.order_id });
    return;
  }

  const { order } = await square.sq<{ order: Order }>(env, `/v2/orders/${p.order_id}`);
  const to = order.fulfillments?.[0]?.shipment_details?.recipient;
  const addr = p.shipping_address || to?.address;
  const pickup = (p.note || "").includes("PICKUP");
  const shop = env.SALES_TO || env.COMMISSION_TO;
  const name = to?.display_name || [addr?.first_name, addr?.last_name].filter(Boolean).join(" ");
  const email = p.buyer_email_address || to?.email_address || "";
  const street = addressLines(addr);

  const items = (order.line_items || []).flatMap((l) => {
    const extras = [l.variation_name && l.variation_name !== "Regular" ? l.variation_name : "", ...(l.modifiers || []).map((m) => m.name)].filter(Boolean);
    return [
      `${l.quantity || 1} x ${l.name || "Item"}${extras.length ? ` (${extras.join(", ")})` : ""}  ${usd(cents(l.gross_sales_money || l.total_money))}`,
      ...(l.note ? [`    Note: ${l.note}`] : [])
    ];
  });

  // Square's fee is sometimes added to the payment a moment after it completes.
  const total = cents(p.total_money || order.total_money);
  const fees = p.processing_fee;
  const fee = (fees || []).reduce((n, f) => n + cents(f.amount_money), 0);
  const moneyRows = [
    ...(order.discounts || []).map((d) => row(d.name || "Discount", -cents(d.applied_money))),
    ...(order.service_charges || []).map((s) => row(s.name || "Shipping", cents(s.amount_money))),
    row("Sales tax", cents(order.total_tax_money)),
    row("Total paid", total),
    ...(fees && fees.length
      ? [row("Square fee", -fee), row("You receive", total - fee)]
      : ["Square fee:   not posted yet (it's on the payment in Square Dashboard)"])
  ];

  await env.GC_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  try {
    await send(env, {
      from: env.EMAIL_FROM,
      to: [shop],
      reply_to: email || shop,
      subject: `New website order: ${(order.line_items || []).map((l) => l.name).filter(Boolean).join(", ") || usd(total)} (${pickup ? "pickup" : "ship"})`,
      text: [
        ...(pickup
          ? ["LOCAL PICKUP: email the buyer to set a time."]
          : street.length
            ? ["SHIP TO:", name || "(no name given)", ...street]
            : ["SHIP TO: the address didn't come through with the payment. Get it from the order in Square Dashboard before packing."]),
        "",
        `Buyer: ${[name, email, to?.phone_number].filter(Boolean).join(" · ") || "see the order in Square"}`,
        "",
        "ITEMS:",
        ...items,
        "",
        ...moneyRows,
        "",
        ...(p.receipt_url ? [`Receipt the buyer got: ${p.receipt_url}`] : []),
        `Square order ID: ${p.order_id}`,
        "",
        "--",
        `The full order is in Square Dashboard under Orders.${email ? " Reply to this email to write to the buyer." : ""}`
      ].join("\n")
    });
  } catch (e) {
    await env.GC_KV.delete(doneKey);
    throw e;
  }
  await logEvent(env, "Emailed the shop about a website order", { order: p.order_id });
}
