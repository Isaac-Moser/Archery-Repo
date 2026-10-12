/* =====================================================================
   MOSER ARCHERY — STRIPE WEBHOOK (Cloudflare Pages Function)
   =====================================================================
   Lives at /functions/stripe-webhook.js -- Cloudflare Pages serves this
   as POST /stripe-webhook automatically.

   Stripe calls this directly from its own servers the instant a payment
   actually clears -- independent of the customer's browser or the
   redirect back to your site. Verifies the request is genuinely from
   Stripe, pulls the saved order back out of KV, and emails it to you.

   REQUIRES, in the Cloudflare Pages dashboard (Settings):
   1. The same "ORDERS_KV" binding as create-checkout-session.js.
   2. Environment variable STRIPE_WEBHOOK_SECRET (mark it "Encrypted") --
      you get this value from Stripe Dashboard -> Developers -> Webhooks
      after adding this URL as an endpoint there.
   3. A "send_email" binding named "EMAIL" (Settings -> Functions ->
      Email bindings), which requires your domain to be onboarded under
      Cloudflare's Email Service AND moserarchery.orders@gmail.com added
      and verified as a destination address under Email Routing first --
      see the setup checklist Claude gave you.
   4. Environment variables BUSINESS_EMAIL and FROM_ADDRESS.
===================================================================== */

export async function onRequestPost(context) {
  const { request, env } = context;

  const payload = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';

  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('Server misconfigured: STRIPE_WEBHOOK_SECRET missing', { status: 500 });
  const verified = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return new Response('Signature verification failed', { status: 400 });

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Card payments arrive as checkout.session.completed with payment_status 'paid'.
  // Bank payments (ACH etc.) complete first as 'unpaid' and the money clears days
  // later as checkout.session.async_payment_succeeded. Only email once it's paid.
  const handled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!handled.includes(event.type)) {
    // Not an event we care about -- acknowledge so Stripe doesn't retry it.
    return new Response('Ignored', { status: 200 });
  }

  const session = event.data.object || {};
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return new Response('Not paid yet; waiting for async_payment_succeeded', { status: 200 });
  }
  const orderRef = session.metadata?.order_ref || '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orderRef)) {
    return new Response('No valid order ref', { status: 200 });
  }

  // Stripe may deliver the same webhook more than once (it retries on
  // anything but a clean 200). This marker makes sure a duplicate
  // delivery never emails you the same paid order twice.
  const sentMarkerKey = 'sent:' + orderRef;
  if (await env.ORDERS_KV.get(sentMarkerKey)) {
    return new Response('Already processed', { status: 200 });
  }

  const orderText = await env.ORDERS_KV.get('order:' + orderRef);
  const amountTotal = session.amount_total != null ? (session.amount_total / 100).toFixed(2) : '?';
  const customerEmail = session.customer_details?.email || session.customer_email || '?';

  const subject = `PAID — Order ${orderRef} — $${amountTotal}`;
  const body =
    `Payment confirmed by Stripe.\nOrder ref: ${orderRef}\nAmount paid: $${amountTotal}\nCustomer email (from Stripe): ${customerEmail}\n\n` +
    (orderText || `(Order text not found in KV for ref ${orderRef} -- check the Stripe dashboard for session ${session.id})`);

  const mailError = await sendOrderEmail(env, subject, body, customerEmail);
  if (mailError) {
    // Answer with an error so Stripe retries (it keeps trying for up to 3 days and
    // flags the failing endpoint in the dashboard). The sent marker below means a
    // retry never emails the same order twice.
    return new Response('Mail failed: ' + mailError, { status: 500 });
  }
  await env.ORDERS_KV.put(sentMarkerKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 30 });
  return new Response('OK', { status: 200 });
}

// Returns null when the email went out, otherwise a short reason.
async function sendOrderEmail(env, subject, body, replyTo) {
  if (!env.EMAIL || !env.BUSINESS_EMAIL || !env.FROM_ADDRESS) return 'EMAIL binding, BUSINESS_EMAIL or FROM_ADDRESS not set';
  try {
    const msg = { to: env.BUSINESS_EMAIL, from: env.FROM_ADDRESS, subject, text: body };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) msg.replyTo = replyTo;   // Cloudflare spells it replyTo
    await env.EMAIL.send(msg);
    return null;
  } catch (err) {
    return (err && (err.code || err.message)) || 'unknown error';
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) return false; // older than 5 minutes

  const signedPayload = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, parts.v1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
