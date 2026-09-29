/* =====================================================================
   MOSER ARCHERY — CREATE STRIPE CHECKOUT SESSION (Cloudflare Pages Function)
   =====================================================================
   Lives at /functions/create-checkout-session.js in your GitHub repo --
   Cloudflare Pages automatically serves this as POST /create-checkout-session,
   no build step or router needed.

   Called by index.html's "Buy Now" button. Re-checks the price SERVER-SIDE
   (never trusts prices coming from the customer's browser -- anyone can
   open devtools and change what a page's JavaScript sends), saves the full
   order text to Workers KV so the webhook can email it to you once payment
   actually clears, and asks Stripe for a hosted payment page URL.

   REQUIRES two things set up in the Cloudflare Pages dashboard (Settings):
   1. A KV namespace bound as "ORDERS_KV" (Settings -> Functions -> KV
      namespace bindings).
   2. Environment variables: STRIPE_SECRET_KEY (mark it "Encrypted") and
      optionally SITE_URL (defaults to https://moserarchery.com).
   See the setup checklist Claude gave you for the exact click-path.
===================================================================== */

const PACK_PRICES_CENTS = { 12: 3000, 18: 4000 }; // same prices as index.html's PACK_PRICES -- keep in sync
// Extra charged per pack for a custom (Studio-designed) shape -- keep in
// sync with CUSTOM_SHAPE_SURCHARGE in index.html, which only drives the
// on-page price display; THIS is what actually sets the Stripe charge,
// since this function never trusts amounts sent from the browser.
const CUSTOM_SHAPE_SURCHARGE_CENTS = 2000;
const SHIPPING_FLAT_CENTS = 499;
const FREE_SHIP_MIN_PACKS = 2;
const FREE_SHIP_MIN_SUBTOTAL_CENTS = 8000;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();
    const name = (data.name || '').trim();
    const email = (data.email || '').trim();
    const address = (data.address || '').trim();
    const notes = (data.notes || '').trim();
    const items = Array.isArray(data.items) ? data.items : [];
    const fullOrderText = data.fullOrderText || '';
    const orderRef = (data.orderRef || '').trim();

    if (!name || !email) return jsonError('Name and email are required', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('Invalid email', 400);
    if (items.length === 0) return jsonError('No items in order', 400);
    // Order ref only ever becomes a KV key, but it's still whitelisted
    // before use, same discipline as if it were a filename.
    if (!/^[A-Za-z0-9-]{1,64}$/.test(orderRef)) return jsonError('Invalid order reference', 400);

    const lineItems = [];
    let itemsSubtotalCents = 0;
    let totalPacks = 0;

    for (const item of items) {
      const packSize = parseInt(item.packSize, 10);
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      const description = String(item.description || 'Custom vane pack').slice(0, 300);
      const basePrice = PACK_PRICES_CENTS[packSize];
      if (!basePrice) return jsonError('Unknown pack size: ' + packSize, 400);
      const isCustom = item.isCustom === true;
      const unitAmount = basePrice + (isCustom ? CUSTOM_SHAPE_SURCHARGE_CENTS : 0);

      lineItems.push({
        currency: 'usd',
        unit_amount: unitAmount,
        name: `Moser Archery vanes — pack of ${packSize}`,
        description,
        quantity: qty,
      });
      itemsSubtotalCents += unitAmount * qty;
      totalPacks += qty;
    }

    const freeShipping = totalPacks >= FREE_SHIP_MIN_PACKS || itemsSubtotalCents >= FREE_SHIP_MIN_SUBTOTAL_CENTS;
    const shippingCents = freeShipping ? 0 : SHIPPING_FLAT_CENTS;
    if (shippingCents > 0) {
      lineItems.push({ currency: 'usd', unit_amount: shippingCents, name: 'Shipping', quantity: 1 });
    }

    // Save the full order (specs, studio copy-paste lines, JSON backup) to
    // KV, keyed by order ref. The webhook reads this back once Stripe
    // confirms payment -- and it expires on its own after 7 days if a
    // checkout is started but never completed.
    if (!env.ORDERS_KV) return jsonError('Server misconfigured: ORDERS_KV binding missing', 500);
    await env.ORDERS_KV.put(
      'order:' + orderRef,
      `Name: ${name}\nEmail: ${email}\nAddress: ${address || '(not provided)'}\nNotes: ${notes || '(none)'}\n\n${fullOrderText}`,
      { expirationTtl: 60 * 60 * 24 * 7 }
    );

    const siteUrl = env.SITE_URL || 'https://moserarchery.com';
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('customer_email', email);
    params.set('success_url', `${siteUrl}/order-success.html?ref=${encodeURIComponent(orderRef)}&session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${siteUrl}/index.html#checkout`);
    params.set('metadata[order_ref]', orderRef);
    lineItems.forEach((li, i) => {
      params.set(`line_items[${i}][price_data][currency]`, li.currency);
      params.set(`line_items[${i}][price_data][unit_amount]`, String(li.unit_amount));
      params.set(`line_items[${i}][price_data][product_data][name]`, li.name);
      if (li.description) params.set(`line_items[${i}][price_data][product_data][description]`, li.description);
      params.set(`line_items[${i}][quantity]`, String(li.quantity));
    });

    if (!env.STRIPE_SECRET_KEY) return jsonError('Server misconfigured: STRIPE_SECRET_KEY missing', 500);
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(env.STRIPE_SECRET_KEY + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await stripeRes.json();
    if (!stripeRes.ok || !session.url) {
      return jsonError('Stripe error: ' + (session.error?.message || 'Unknown error'), 502);
    }

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return jsonError('Server error: ' + err.message, 500);
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
