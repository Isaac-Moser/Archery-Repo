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

const PACK_PRICES_CENTS = { 6: 2000, 12: 3000, 18: 4000 }; // same prices as index.html's PACK_PRICES -- keep in sync
// Added per pack for a customer-designed shape. Keep in sync with
// CUSTOM_FEE in index.html (display only -- this is the real charge).
const CUSTOM_SHAPE_SURCHARGE_CENTS = 1000;
const SHIPPING_FLAT_CENTS = 499;
const MAX_PACKS_PER_ITEM = 10; // same cap as index.html's MAX_PACKS_PER_ITEM
const MAX_ITEMS = 25;          // sanity cap on cart lines
// Free shipping at $40+ item subtotal (custom fees included). Keep in sync
// with SHIPPING.freeAtSubtotal in index.html.
const FREE_SHIP_MIN_SUBTOTAL_CENTS = 4000;
// We ship to US addresses only (see shipping-returns.html). Same list as US_STATES in index.html.
const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

// Checks the separate address boxes from the checkout form. Returns
// {ship} when complete, or {error, field} naming the box to fix.
function checkShipping(raw) {
  const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const r = raw && typeof raw === 'object' ? raw : {};
  const street = one(r.street, 80), street2 = one(r.street2, 40), city = one(r.city, 40), state = one(r.state, 2).toUpperCase();
  const zipM = one(r.zip, 10).match(/^(\d{5})(?:[-\s]?(\d{4}))?$/);
  if (street.length < 4) return { error: 'Enter your street address.', field: '#custStreet' };
  if (!/\d/.test(street)) return { error: 'Add your house or building number to the street address.', field: '#custStreet' };
  if (city.length < 2 || /\d/.test(city)) return { error: 'Enter your city.', field: '#custCity' };
  if (!US_STATES.includes(state)) return { error: 'Choose your state.', field: '#custState' };
  if (!zipM) return { error: 'Enter a 5-digit ZIP code, like 58102.', field: '#custZip' };
  return { ship: { street, street2, city, state, zip: zipM[1] + (zipM[2] ? '-' + zipM[2] : '') } };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const data = await request.json();
    const name = (data.name || '').trim();
    const email = (data.email || '').trim();
    const checked = checkShipping(data.shipping);
    if (checked.error) return jsonError(checked.error, 400, checked.field);
    const ship = checked.ship;
    const notes = (data.notes || '').trim();
    const items = Array.isArray(data.items) ? data.items : [];
    const fullOrderText = data.fullOrderText || '';
    const orderRef = (data.orderRef || '').trim();

    if (!name || !email) return jsonError('Name and email are required', 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError('Invalid email', 400);
    if (items.length === 0) return jsonError('No items in order', 400);
    if (items.length > MAX_ITEMS) return jsonError('Too many items in one order', 400);
    // Order ref only ever becomes a KV key, but it's still whitelisted
    // before use, same discipline as if it were a filename.
    if (!/^[A-Za-z0-9-]{1,64}$/.test(orderRef)) return jsonError('Invalid order reference', 400);

    const lineItems = [];
    let itemsSubtotalCents = 0;
    let totalPacks = 0;

    for (const item of items) {
      const packSize = parseInt(item.packSize, 10);
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PACKS_PER_ITEM) {
        return jsonError(`Quantity must be 1 to ${MAX_PACKS_PER_ITEM} packs per item`, 400);
      }
      const description = String(item.description || 'Custom vane pack').slice(0, 300);
      const basePrice = PACK_PRICES_CENTS[packSize];
      if (!basePrice) return jsonError('Unknown pack size: ' + packSize, 400);
      const isCustom = item.customShape === true;
      const unitAmount = basePrice + (isCustom ? CUSTOM_SHAPE_SURCHARGE_CENTS : 0);

      lineItems.push({
        currency: 'usd',
        unit_amount: unitAmount,
        name: `Moser Archery vanes — pack of ${packSize}${isCustom ? ' (custom shape)' : ''}`,
        description,
        quantity: qty,
      });
      itemsSubtotalCents += unitAmount * qty;
      totalPacks += qty;
    }

    const freeShipping = itemsSubtotalCents >= FREE_SHIP_MIN_SUBTOTAL_CENTS;
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
      `Name: ${name}\nEmail: ${email}\n` +
        `SHIP TO:\n  ${name}\n  ${ship.street}${ship.street2 ? ', ' + ship.street2 : ''}\n  ${ship.city}, ${ship.state} ${ship.zip}\n  United States\n` +
        `Notes: ${notes || '(none)'}\n\n${fullOrderText}`,
      { expirationTtl: 60 * 60 * 24 * 7 }
    );

    const siteUrl = env.SITE_URL || 'https://moserarchery.com';
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('customer_email', email);
    params.set('success_url', `${siteUrl}/order-success.html?ref=${encodeURIComponent(orderRef)}&session_id={CHECKOUT_SESSION_ID}`);
    params.set('cancel_url', `${siteUrl}/index.html#checkout`);
    params.set('metadata[order_ref]', orderRef);
    // Puts the shipping address on the payment in your Stripe dashboard too.
    params.set('payment_intent_data[shipping][name]', name.slice(0, 100));
    params.set('payment_intent_data[shipping][address][line1]', ship.street);
    if (ship.street2) params.set('payment_intent_data[shipping][address][line2]', ship.street2);
    params.set('payment_intent_data[shipping][address][city]', ship.city);
    params.set('payment_intent_data[shipping][address][state]', ship.state);
    params.set('payment_intent_data[shipping][address][postal_code]', ship.zip);
    params.set('payment_intent_data[shipping][address][country]', 'US');
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

function jsonError(message, status, field) {
  return new Response(JSON.stringify(field ? { error: message, field } : { error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
