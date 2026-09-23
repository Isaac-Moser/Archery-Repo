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

  if (event.type !== 'checkout.session.completed') {
    return new Response('Ignored', { status: 200 });
  }

  const session = event.data.object || {};
  const orderRef = session.metadata?.order_ref || '';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(orderRef)) {
    return new Response('No valid order ref', { status: 200 });
  }

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

  const sent = await sendOrderEmail(env, subject, body, customerEmail);
  if (sent) {
    await env.ORDERS_KV.put(sentMarkerKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return new Response(sent ? 'OK' : 'Mail failed, but acknowledged', { status: 200 });
}

async function sendOrderEmail(env, subject, body, replyTo) {
  if (!env.EMAIL || !env.BUSINESS_EMAIL || !env.FROM_ADDRESS) return false;
  try {
    await env.EMAIL.send({
      to: env.BUSINESS_EMAIL,
      from: env.FROM_ADDRESS,
      subject,
      text: body,
      reply_to: replyTo,
    });
    return true;
  } catch {
    return false;
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) return false;

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

