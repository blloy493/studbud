// api/stripe-webhook.js
// Vercel serverless function. Deploy path: /api/stripe-webhook
// Called by Stripe, not by the extension, so guard() (Origin check) is NOT used. The signature check replaces it.
// Requires env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
//
// Events to enable on the webhook endpoint (nothing else is handled):
//   checkout.session.completed   a pass purchase (weekly / semester / yearly), including $0 promo-code checkouts
//   invoice.paid                 subscription renewals only (billing_reason === 'subscription_cycle')
//   customer.subscription.deleted  subscription ended (immediate cancel, or period end after a scheduled cancel)
// A scheduled cancel needs no handling: access simply stops at the stored period end.
// invoice.paid and customer.subscription.deleted only matter for installs that bought the old monthly subscription; passes are one-time payments.
// Refunds and disputes are NOT handled: do those by hand for now.

import Stripe from 'stripe';
import { getRedis } from './_lib/guard.js';
import { USER_ID_RE, PASS_DAYS, grantUntil, extendPass, endNow, userIdForCustomer, recordServerEvent } from './_lib/entitlement.js';

// Stripe's signature is computed over the unparsed body, so Vercel's body parsing must be off.
// Verify this works on your project in test mode (the Stripe CLI `stripe listen` + `stripe trigger` is enough).
export const config = { api: { bodyParser: false } };

let stripe;
function getStripe() {
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

// The subscription's paid-through time in seconds. Newer Stripe API versions keep it on the subscription item,
// older ones on the subscription itself, so both are read.
function periodEnd(sub) {
  return (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || sub.current_period_end;
}

async function onCheckoutCompleted(session) {
  const userId = session.client_reference_id;
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    console.error('[stripe-webhook] checkout without a valid client_reference_id:', session.id);
    return;
  }
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return; // not paid yet
  const customerId = typeof session.customer === 'string' ? session.customer : undefined;

  if (session.mode === 'payment') {
    // The plan comes from the metadata checkout.js sets. Sessions created before the pass plans shipped have none and were semester passes.
    const plan = (session.metadata && session.metadata.plan) || 'semester';
    if (!PASS_DAYS[plan]) throw new Error(`unknown pass plan "${plan}" on session ${session.id}`); // 500: visible in Stripe's failed-webhook list
    await extendPass(userId, plan, customerId);
    // $0 checkouts (promo and gift codes) are counted apart from purchases so the purchase funnel stays clean.
    await recordServerEvent(userId, session.payment_status === 'no_payment_required' ? `gift_redeemed_${plan}` : `purchase_completed_${plan}`);
  } else if (session.mode === 'subscription') {
    const sub = await getStripe().subscriptions.retrieve(session.subscription);
    const end = periodEnd(sub);
    if (!end) throw new Error(`no period end on subscription ${sub.id}`);
    await grantUntil(userId, { exp: end * 1000, plan: 'monthly', customerId });
  }
}

async function onInvoicePaid(invoice) {
  if (invoice.billing_reason !== 'subscription_cycle') return; // the first invoice is covered by checkout.session.completed
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : undefined;
  const userId = customerId && (await userIdForCustomer(customerId));
  if (!userId) throw new Error(`no install mapped to customer ${customerId}`); // 500 -> Stripe retries
  const line = invoice.lines && invoice.lines.data && invoice.lines.data[0];
  if (!line || !line.period || !line.period.end) throw new Error(`no period on invoice ${invoice.id}`);
  await grantUntil(userId, { exp: line.period.end * 1000, plan: 'monthly', customerId });
}

async function onSubscriptionDeleted(sub) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : undefined;
  const userId = (sub.metadata && sub.metadata.userId) || (customerId && (await userIdForCustomer(customerId)));
  if (!userId) throw new Error(`no install mapped to subscription ${sub.id}`);
  await endNow(userId);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = getStripe().webhooks.constructEvent(await rawBody(req), sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[stripe-webhook] signature check failed:', err.message);
    return res.status(400).json({ error: 'Bad signature' });
  }

  // Stripe retries and can deliver an event twice. extendSemester adds time, so a repeat would double it: dedupe by event id.
  const r = getRedis();
  const dedupeKey = `stripe:evt:${event.id}`;
  if (r) {
    const fresh = await r.set(dedupeKey, 1, { nx: true, ex: 60 * 60 * 24 * 7 });
    if (!fresh) return res.status(200).json({ duplicate: true });
  }

  try {
    if (event.type === 'checkout.session.completed') await onCheckoutCompleted(event.data.object);
    else if (event.type === 'invoice.paid') await onInvoicePaid(event.data.object);
    else if (event.type === 'customer.subscription.deleted') await onSubscriptionDeleted(event.data.object);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[stripe-webhook] handler failed:', event.type, err);
    if (r) await r.del(dedupeKey).catch(() => {}); // let Stripe's retry run it again
    return res.status(500).json({ error: 'Internal server error' });
  }
}
