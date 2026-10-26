/* =====================================================================
   MOSER ARCHERY — PHOTO SUBMISSIONS (Cloudflare Pages Function)
   =====================================================================
   Lives at /functions/submit-photos.js -- served as POST /submit-photos.

   The Photos page form sends the customer's details and up to 4 photos
   (already shrunk to JPEG in their browser, which strips location data).
   This re-checks everything -- including that the permission box was
   checked -- and emails the submission to you from FROM_ADDRESS, with the
   photos attached. Anything that didn't come through this form won't have
   this email's format, sender or submission ID.

   Uses the same Production settings as stripe-webhook.js:
     BUSINESS_EMAIL, FROM_ADDRESS, CF_ACCOUNT_ID, CF_EMAIL_API_TOKEN
   and ORDERS_KV (only for a short-lived spam limit, keyed by a hash).
===================================================================== */

const MAX_PHOTOS = 4;
const MAX_PHOTO_B64 = 1_400_000;     // ~1 MB per photo after base64
const MAX_TOTAL_B64 = 4_200_000;     // stays under the 5 MiB email limit
const PER_HOUR_LIMIT = 6;            // submissions per visitor per hour
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const PROFILES = ['', 'GHOST', 'RIDGE', 'IMPACT', 'RANGE', 'ANCHOR'];

export async function onRequestPost({ request, env }) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > 6_000_000) return reply(413, 'Those photos are too big. Try fewer photos.');

  let d;
  try { d = await request.json(); } catch { return reply(400, 'That submission could not be read.'); }

  // Bots fill the hidden "website" field; people never see it.
  if (d.website) return reply(200, null, { ok: true, id: 'PS-0' });

  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const firstName = clean(d.firstName, 30);
  const lastName = clean(d.lastName, 40);
  const town = clean(d.town, 40);
  const state = clean(d.state, 2).toUpperCase();
  const email = clean(d.email, 80);
  const profile = clean(d.profile, 10).toUpperCase();
  const rating = Number.isInteger(d.rating) && d.rating >= 1 && d.rating <= 5 ? d.rating : 0;
  const review = String(d.review ?? '').replace(/\r/g, '').trim().slice(0, 600);
  const photos = Array.isArray(d.photos) ? d.photos : [];

  if (d.consent !== true) return reply(400, 'Check the permission box so we can post your photos.');
  if (!firstName) return reply(400, 'Add your first name.');
  if (!rating) return reply(400, 'Pick a star rating.');
  if (!review) return reply(400, 'Tell us how they fly.');
  if (!STATES.includes(state)) return reply(400, 'Pick your state.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, 'That email doesn\'t look right.');
  if (!PROFILES.includes(profile)) return reply(400, 'Unknown profile.');
  if (photos.length < 1) return reply(400, 'Add at least one photo.');
  if (photos.length > MAX_PHOTOS) return reply(400, `Up to ${MAX_PHOTOS} photos.`);
  let total = 0;
  for (const p of photos) {
    // Every photo arrives as JPEG (the browser re-saves it), which starts "/9j/" in base64.
    if (typeof p !== 'string' || !p.startsWith('/9j/') || !/^[A-Za-z0-9+/=]+$/.test(p.slice(0, 200))) return reply(400, 'One of the photos could not be read.');
    if (p.length > MAX_PHOTO_B64) return reply(413, 'One of the photos is too big.');
    total += p.length;
  }
  if (total > MAX_TOTAL_B64) return reply(413, 'Those photos are too big together. Try fewer photos.');

  // Light spam limit: count submissions per visitor (hashed address, kept 1 hour).
  if (env.ORDERS_KV) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ps:' + ip)))].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = 'rl:photos:' + hash;
    const n = Number(await env.ORDERS_KV.get(key)) || 0;
    if (n >= PER_HOUR_LIMIT) return reply(429, 'Too many submissions. Please try again in an hour.');
    await env.ORDERS_KV.put(key, String(n + 1), { expirationTtl: 3600 });
  }

  // Shown publicly as first name + last initial, same as the Reviews tab: "Sawyer M. · Roseau, MN".
  const showAs = `${firstName}${lastName ? ' ' + lastName[0].toUpperCase() + '.' : ''} · ${town ? town + ', ' : ''}${state}`;
  const fullName = `${firstName}${lastName ? ' ' + lastName : ''}`;
  const ymd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).replace(/-/g, '').slice(2);   // YYMMDD, Central time
  const id = 'PS-' + ymd + '-' + crypto.randomUUID().slice(0, 4).toUpperCase();
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const slug = showAs.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const subject = `Photo submission: ${showAs}${profile ? ' · ' + profile : ''} · ${rating}/5`;

  const text = [
    'MOSER ARCHERY — PHOTO SUBMISSION',
    'Sent through the Photos page form on moserarchery.com',
    '',
    `Name:      ${fullName}`,
    `Show as:   ${showAs}`,
    `Location:  ${town ? town + ', ' : ''}${state}`,
    `Profile:   ${profile || 'Not sure'}`,
    `Rating:    ${rating} of 5`,
    `Email:     ${email || '(not given)'}`,
    `Photos:    ${photos.length} attached`,
    '',
    'Review:',
    review || '(none)',
    '',
    `PERMISSION: Box checked at ${when}.`,
    '"I took these photos, I\'m 13 or older, and anyone else in them is OK with it. Moser Archery may post my photos and review, with my first name, last initial, town and state, on its website and social media."',
    '',
    `Submission ID: ${id}`,
  ].join('\n');

  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const row = (k, v) => `<tr><td style="padding:8px 12px 8px 0;color:#56635D;font-size:14px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:8px 0;font-size:15px;color:#1C2421;font-weight:600">${v}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#E4E9E6;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E4E9E6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#1C2421;padding:18px 24px;color:#EEF2EF">
  <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#A9B5AF">Moser Archery</div>
  <div style="font-size:22px;font-weight:700;margin-top:4px">Photo submission</div>
</td></tr>
<tr><td style="padding:20px 24px 4px">
  <div style="display:inline-block;background:#DDEBE1;color:#2F6A48;font-size:13px;font-weight:700;padding:6px 10px;border-radius:6px">&#10003; Sent through the Photos page form</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px">
    ${row('Name', e(fullName))}
    ${row('Show as', e(showAs))}
    ${row('Location', e((town ? town + ', ' : '') + state))}
    ${row('Profile', e(profile || 'Not sure'))}
    ${row('Rating', `<span style="color:#C43237;letter-spacing:1px">${e(stars)}</span>`)}
    ${row('Email', email ? `<a href="mailto:${e(email)}" style="color:#1C2421">${e(email)}</a>` : '<span style="color:#56635D;font-weight:400">Not given</span>')}
    ${row('Photos', `${photos.length} attached`)}
  </table>
</td></tr>
<tr><td style="padding:8px 24px 4px">
  <div style="font-size:14px;color:#56635D;margin-bottom:6px">Review</div>
  <div style="border-left:4px solid #C43237;background:#F6F8F7;padding:12px 14px;font-size:16px;line-height:1.5;color:#1C2421">${review ? e(review).replace(/\n/g, '<br>') : '<span style="color:#56635D">No review written.</span>'}</div>
</td></tr>
<tr><td style="padding:16px 24px">
  <div style="background:#DDEBE1;border:1px solid #b9d2c1;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5;color:#1C2421">
    <b style="color:#2F6A48">&#10003; Permission box checked</b> &middot; ${e(when)}<br>
    <span style="color:#3d4a44">&ldquo;I took these photos, I&rsquo;m 13 or older, and anyone else in them is OK with it. Moser Archery may post my photos and review, with my first name, last initial, town and state, on its website and social media.&rdquo;</span>
  </div>
</td></tr>
<tr><td style="padding:0 24px 20px;font-size:12px;color:#56635D">Submission ID: ${e(id)} &middot; Photos are attached to this email.</td></tr>
</table></td></tr></table></body></html>`;

  const err = await sendEmail(env, {
    to: env.BUSINESS_EMAIL,
    from: env.FROM_ADDRESS,
    subject,
    text,
    html,
    attachments: photos.map((p, i) => ({ content: p, filename: `${slug}-${i + 1}.jpg`, type: 'image/jpeg', disposition: 'attachment' })),
  });
  if (err) return reply(502, 'We couldn\'t send that just now. Please try again in a few minutes.', { detail: err });

  return reply(200, null, { ok: true, id });
}

async function sendEmail(env, msg) {
  if (!env.BUSINESS_EMAIL || !env.FROM_ADDRESS) return 'BUSINESS_EMAIL or FROM_ADDRESS not set';
  if (!env.CF_ACCOUNT_ID || !env.CF_EMAIL_API_TOKEN) return 'CF_ACCOUNT_ID or CF_EMAIL_API_TOKEN not set';
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.CF_EMAIL_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.ok && data && data.success) return null;
    return data && Array.isArray(data.errors) && data.errors.length ? data.errors.map(x => `${x.code} ${x.message}`).join('; ') : 'HTTP ' + res.status;
  } catch (x) {
    return (x && x.message) || 'network error';
  }
}

function reply(status, error, body) {
  return new Response(JSON.stringify(Object.assign({ ok: !error }, error ? { error } : {}, body || {})), { status, headers: { 'Content-Type': 'application/json' } });
}
