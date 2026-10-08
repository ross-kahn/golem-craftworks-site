// Website sales: emails the shop when the payment for a website order goes through.
// Square emails the buyer their receipt; this is the shop's copy, with what to pack, where to send it and the money.

import * as square from "./square.ts";
import { mailReady, send } from "./commission.ts";
import type { MailEnv } from "./commission.ts";
import { logEvent, errMsg } from "./util.ts";
import type {
  Env,
  SquareAddress,
  SquareMoney,
  SquarePayment,
  SquareWebhookEvent,
} from "./types.ts";

interface Order {
  line_items?: {
    name?: string;
    variation_name?: string;
    quantity?: string;
    note?: string;
    modifiers?: { name?: string }[];
    gross_sales_money?: SquareMoney;
    total_money?: SquareMoney;
  }[];
  customer_id?: string;
  fulfillments?: {
    shipment_details?: { recipient?: Recipient };
    delivery_details?: { recipient?: Recipient };
  }[];
  service_charges?: { name?: string; amount_money?: SquareMoney }[]; // the shipping fee
  discounts?: { name?: string; applied_money?: SquareMoney }[];
  total_tax_money?: SquareMoney;
  total_money?: SquareMoney;
}

interface Recipient {
  display_name?: string;
  email_address?: string;
  phone_number?: string;
  address?: SquareAddress;
}
interface Customer {
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
  address?: SquareAddress;
}

// A buyer who pays with Google Pay or Apple Pay skips Square's address form: the address comes from
// their wallet, and Square can attach it to the order a moment after the payment completes.
const ADDRESS_WAIT_MS = 2500;
const ADDRESS_TRIES = 3;

const cents = (m?: SquareMoney) => m?.amount || 0;
const usd = (n: number) =>
  `${n < 0 ? "-" : ""}$${(Math.abs(n) / 100).toFixed(2)}`;
const row = (label: string, n: number) =>
  `${(label + ":").padEnd(14)}${usd(n)}`;

function addressLines(a?: SquareAddress) {
  if (!a) return [];
  return [
    a.address_line_1,
    a.address_line_2,
    a.address_line_3,
    [
      [a.locality, a.administrative_district_level_1]
        .filter(Boolean)
        .join(", "),
      a.postal_code,
    ]
      .filter(Boolean)
      .join(" "),
    a.country && a.country !== "US" ? a.country : "",
  ].filter(Boolean) as string[];
}

// Called for Square's payment events, and by the hourly check for any it missed. Throws if the email can't be sent.
export async function notifySale(
  env: Env,
  event: SquareWebhookEvent,
  wait = ADDRESS_WAIT_MS,
) {
  const p = event.data?.object?.payment;
  // In-person sales don't need an email: only orders that came through the site's checkout.
  if (
    !p ||
    p.status !== "COMPLETED" ||
    !p.order_id ||
    !(p.note || "").startsWith(square.WEBSITE_ORDER_NOTE)
  )
    return;
  const doneKey = `sale:mailed:${p.order_id}`;
  if (await env.GC_KV.get(doneKey)) return; // Square reports a payment more than once
  if (!mailReady(env)) {
    await logEvent(
      env,
      "A website order came in, but email isn't set up so no notification was sent",
      { order: p.order_id },
    );
    return;
  }
  // Square's reports of one payment arrive seconds apart, and this can take that long: the first one takes it.
  const claimKey = `sale:mailing:${p.order_id}`;
  if (await env.GC_KV.get(claimKey)) return;
  await env.GC_KV.put(claimKey, "1", { expirationTtl: 60 });
  try {
    await mailSale(env, p, doneKey, wait);
  } catch (e) {
    await env.GC_KV.delete(claimKey);
    throw e;
  }
}

// Website payments from the last day that never got their email (a missed or failed report from Square).
export async function mailMissedSales(env: Env) {
  if (!mailReady(env)) return;
  const begin = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({
      begin_time: begin,
      location_id: env.SQUARE_LOCATION_ID,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    const data = await square.sq<{
      payments?: SquarePayment[];
      cursor?: string;
    }>(env, `/v2/payments?${query}`);
    for (const payment of data.payments || []) {
      try {
        await notifySale(env, { data: { object: { payment } } });
      } catch (e) {
        await logEvent(
          env,
          "WEBSITE ORDER: the email to the shop failed again. Check Square Dashboard for the order",
          { order: payment.order_id, error: errMsg(e) },
        );
      }
    }
    cursor = data.cursor;
  } while (cursor);
}

async function mailSale(
  env: MailEnv,
  p: SquarePayment,
  doneKey: string,
  wait: number,
) {
  const pickup = (p.note || "").includes("PICKUP");
  const shop = env.SALES_TO || env.COMMISSION_TO;

  // Where to send it: the payment, then the order, then (last resort) the buyer's customer record.
  let pay = p;
  let order: Order = {};
  let to: Recipient | undefined;
  let addr: SquareAddress | undefined;
  let addressFrom = "";
  for (let i = 0; i < ADDRESS_TRIES; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, wait));
      if (p.id)
        pay = (
          await square
            .sq<{ payment: typeof p }>(env, `/v2/payments/${p.id}`)
            .catch(() => ({ payment: pay }))
        ).payment;
    }
    ({ order } = await square.sq<{ order: Order }>(
      env,
      `/v2/orders/${p.order_id}`,
    ));
    to = (order.fulfillments || [])
      .map(
        (f) => f.shipment_details?.recipient || f.delivery_details?.recipient,
      )
      .find((r) => r);
    // A wallet payment carries a shipping address with only the name in it; the street is on the order.
    const onPayment = addressLines(pay.shipping_address).length > 0;
    addr = onPayment
      ? pay.shipping_address
      : to?.address || pay.shipping_address;
    addressFrom = onPayment
      ? "payment"
      : addressLines(to?.address).length
        ? "order"
        : "";
    if (pickup || addressLines(addr).length) break;
  }
  let customer: Customer | undefined;
  const customerId = order.customer_id || pay.customer_id;
  if (!pickup && !addressLines(addr).length && customerId) {
    customer = (
      await square
        .sq<{ customer?: Customer }>(env, `/v2/customers/${customerId}`)
        .catch(() => ({ customer: undefined }))
    ).customer;
    if (addressLines(customer?.address).length) {
      addr = customer!.address;
      addressFrom = "customer";
    }
  }
  const name =
    to?.display_name ||
    [addr?.first_name, addr?.last_name].filter(Boolean).join(" ") ||
    [customer?.given_name, customer?.family_name].filter(Boolean).join(" ");
  const email =
    pay.buyer_email_address ||
    to?.email_address ||
    customer?.email_address ||
    "";
  const phone = to?.phone_number || customer?.phone_number;
  const street = addressLines(addr);

  const items = (order.line_items || []).flatMap((l) => {
    const extras = [
      l.variation_name && l.variation_name !== "Regular"
        ? l.variation_name
        : "",
      ...(l.modifiers || []).map((m) => m.name),
    ].filter(Boolean);
    return [
      `${l.quantity || 1} x ${l.name || "Item"}${extras.length ? ` (${extras.join(", ")})` : ""}  ${usd(cents(l.gross_sales_money || l.total_money))}`,
      ...(l.note ? [`    Note: ${l.note}`] : []),
    ];
  });

  // Square's fee is sometimes added to the payment a moment after it completes.
  const total = cents(pay.total_money || order.total_money);
  const fees = pay.processing_fee;
  const fee = (fees || []).reduce((n, f) => n + cents(f.amount_money), 0);
  const moneyRows = [
    ...(order.discounts || []).map((d) =>
      row(d.name || "Discount", -cents(d.applied_money)),
    ),
    ...(order.service_charges || []).map((s) =>
      row(s.name || "Shipping", cents(s.amount_money)),
    ),
    row("Sales tax", cents(order.total_tax_money)),
    row("Total paid", total),
    ...(fees && fees.length
      ? [row("Square fee", -fee), row("You receive", total - fee)]
      : [
          "Square fee:   not posted yet (it's on the payment in Square Dashboard)",
        ]),
  ];

  // Website orders don't add sales tax, so on a Wisconsin order it comes out of what was paid.
  if (
    !cents(order.total_tax_money) &&
    (pickup ||
      /^(WI|Wisconsin)$/i.test(
        (addr?.administrative_district_level_1 || "").trim(),
      ))
  ) {
    moneyRows.push(
      "",
      `WISCONSIN ORDER (${pickup ? "pickup" : "shipped in state"}): no sales tax was collected, so what you owe on it comes out of this total.`,
    );
  }

  await env.GC_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  try {
    await send(env, {
      from: env.EMAIL_FROM,
      to: [shop],
      reply_to: email || shop,
      // The receipt number keeps each order its own conversation in Gmail, which groups matching subjects.
      subject: `💲You got a sale! ${
        (order.line_items || [])
          .map((l) => l.name)
          .filter(Boolean)
          .join(", ") || usd(total)
      }${pay.receipt_number ? ` #${pay.receipt_number}` : ""} (${pickup ? "pickup" : "ship"})`,
      text: [
        ...(pickup
          ? ["LOCAL PICKUP: email the buyer to set a time."]
          : street.length
            ? [
                addressFrom === "customer"
                  ? "SHIP TO (from the buyer's customer record in Square; check it against the order):"
                  : "SHIP TO:",
                name || "(no name given)",
                ...street,
              ]
            : [
                "SHIP TO: Square didn't pass the address along. Get it from the order in Square Dashboard before packing.",
              ]),
        "",
        `Buyer: ${[name, email, phone].filter(Boolean).join(" · ") || "see the order in Square"}`,
        ...(pay.created_at
          ? [
              `Ordered: ${new Date(pay.created_at).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })} Central`,
            ]
          : []),
        ...(pay.receipt_number ? [`Receipt: #${pay.receipt_number}`] : []),
        "",
        "ITEMS:",
        ...items,
        "",
        ...moneyRows,
        "",
        ...(pay.receipt_url
          ? [`Receipt the buyer got: ${pay.receipt_url}`]
          : []),
        `Square order ID: ${p.order_id}`,
        "",
        "--",
        `The full order is in Square Dashboard under Orders.${email ? " Reply to this email to write to the buyer." : ""}`,
      ].join("\n"),
    });
  } catch (e) {
    await env.GC_KV.delete(doneKey);
    throw e;
  }
  await logEvent(env, "Emailed the shop about a website order", {
    order: p.order_id,
    addressFrom: pickup ? "pickup" : addressFrom || "MISSING",
  });
}
