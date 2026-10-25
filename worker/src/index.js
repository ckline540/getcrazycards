/**
 * Crazy Cards checkout worker (Cloudflare Workers).
 *
 * The shop at getcrazycards.com is a static page, so this tiny service does the
 * three things a static page cannot:
 *   POST /checkout  -> builds a Stripe Checkout Session for the cards in the cart
 *   POST /webhook   -> Stripe tells us a session was paid; we mark those cards sold
 *   GET  /sold      -> the shop asks which cards are sold or sitting in someone's checkout
 *
 * Every card is one of a kind, so a card is "reserved" the moment a Checkout
 * Session is created for it (30 minutes) and "sold" once Stripe confirms payment.
 * Both facts live in the SALES KV namespace. Prices are never trusted from the
 * browser: the worker reads inventory.json published by the site itself.
 */

const RESERVE_SECONDS = 30 * 60; // Stripe's minimum Checkout expiry
const INVENTORY_CACHE_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, cors);
      if (url.pathname === "/sold" && request.method === "GET") return await handleSold(env, cors);
      if (url.pathname === "/checkout" && request.method === "POST") return await handleCheckout(request, env, cors);
      if (url.pathname === "/webhook" && request.method === "POST") return await handleWebhook(request, env, ctx);
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err && err.stack || err);
      return json({ error: "Something went wrong on our side. Please try again." }, 500, cors);
    }
  },
};

/* ---------- /sold ---------- */

async function handleSold(env, cors) {
  const [sold, reserved] = await Promise.all([listKeys(env.SALES, "sold:"), listKeys(env.SALES, "reserved:")]);
  return json({ sold, reserved }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function listKeys(kv, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) out.push(k.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/* ---------- /checkout ---------- */

async function handleCheckout(request, env, cors) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Checkout is not configured yet." }, 503, cors);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400, cors); }
  const ids = Array.from(new Set((Array.isArray(body && body.ids) ? body.ids : [])
    .filter((x) => typeof x === "string" && /^[\w-]{1,40}$/.test(x))));
  if (!ids.length) return json({ error: "Your cart is empty." }, 400, cors);
  if (ids.length > 50) return json({ error: "That is too many cards for one order. Text us and we will sort it out." }, 400, cors);

  const inventory = await loadInventory(env);
  const byId = new Map(inventory.map((c) => [c.id, c]));

  const unavailable = [];
  const cards = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c || c.status !== "sell" || !(Number(c.price) > 0)) { unavailable.push(id); continue; }
    const [sold, reserved] = await Promise.all([env.SALES.get("sold:" + id), env.SALES.get("reserved:" + id)]);
    if (sold || reserved) { unavailable.push(id); continue; }
    cards.push(c);
  }
  if (unavailable.length) {
    return json({
      error: unavailable.length === 1
        ? "One card in your cart was just sold or is in someone else's checkout. We removed it. Please try again."
        : "Some cards in your cart were just sold or are in someone else's checkout. We removed them. Please try again.",
      unavailable,
    }, 409, cors);
  }

  const subtotal = cards.reduce((s, c) => s + toCents(c.price), 0);
  const site = (env.SITE_ORIGIN || "https://getcrazycards.com").replace(/\/$/, "");
  const shippingCents = Number(env.SHIPPING_CENTS || 0);
  const freeOver = Number(env.FREE_SHIPPING_OVER_CENTS || 0);
  const freeShipping = shippingCents === 0 || (freeOver > 0 && subtotal >= freeOver);
  const countries = String(env.ALLOWED_COUNTRIES || "US").split(",").map((s) => s.trim()).filter(Boolean);

  const params = {
    mode: "payment",
    success_url: site + "/?paid=1&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: site + "/?canceled=1",
    expires_at: Math.floor(Date.now() / 1000) + RESERVE_SECONDS,
    client_reference_id: "cc-" + Date.now().toString(36),
    "metadata[card_ids]": cards.map((c) => c.id).join(","),
    "payment_intent_data[description]": "Crazy Cards: " + cards.map(cardTitle).join("; ").slice(0, 900),
    "payment_intent_data[metadata][card_ids]": cards.map((c) => c.id).join(","),
    "phone_number_collection[enabled]": "true",
    "shipping_options[0][shipping_rate_data][type]": "fixed_amount",
    "shipping_options[0][shipping_rate_data][fixed_amount][amount]": freeShipping ? 0 : shippingCents,
    "shipping_options[0][shipping_rate_data][fixed_amount][currency]": "usd",
    "shipping_options[0][shipping_rate_data][display_name]": freeShipping ? "Free shipping" : (env.SHIPPING_LABEL || "Tracked shipping"),
    "shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]": "business_day",
    "shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]": 3,
    "shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]": "business_day",
    "shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]": 7,
  };
  countries.forEach((cc, i) => { params["shipping_address_collection[allowed_countries][" + i + "]"] = cc; });
  cards.forEach((c, i) => {
    const p = "line_items[" + i + "]";
    params[p + "[quantity]"] = 1;
    params[p + "[price_data][currency]"] = "usd";
    params[p + "[price_data][unit_amount]"] = toCents(c.price);
    params[p + "[price_data][product_data][name]"] = cardTitle(c).slice(0, 250);
    const desc = cardDescription(c);
    if (desc) params[p + "[price_data][product_data][description]"] = desc.slice(0, 500);
    params[p + "[price_data][product_data][metadata][card_id]"] = c.id;
  });

  const session = await stripe(env, "POST", "/v1/checkout/sessions", params);

  // Hold these cards for this shopper while the session is open.
  await Promise.all(cards.map((c) => env.SALES.put("reserved:" + c.id, session.id, { expirationTtl: RESERVE_SECONDS + 120 })));

  return json({ url: session.url, id: session.id }, 200, cors);
}

function cardTitle(c) {
  return [c.player, c.card].filter(Boolean).join(" - ") + (c.card_number ? " #" + c.card_number : "");
}
function cardDescription(c) {
  return [c.set_year, c.parallel, c.team, c.graded ? "Graded " + (c.grade || "") : ""]
    .map((s) => String(s || "").trim()).filter(Boolean).join(" | ");
}
function toCents(price) { return Math.round(Number(price) * 100); }

async function loadInventory(env) {
  const url = env.INVENTORY_URL || "https://getcrazycards.com/inventory.json";
  const res = await fetch(url, { cf: { cacheTtl: INVENTORY_CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) throw new Error("inventory fetch failed: " + res.status);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.cards;
  if (!Array.isArray(list)) throw new Error("inventory.json has no card list");
  return list;
}

/* ---------- /webhook ---------- */

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("webhook secret not set", { status: 503 });
  const raw = await request.text();
  const sig = request.headers.get("Stripe-Signature") || "";
  const ok = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("bad signature", { status: 400 });

  const event = JSON.parse(raw);
  const session = event.data && event.data.object;
  const ids = String((session && session.metadata && session.metadata.card_ids) || "").split(",").filter(Boolean);

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (session.payment_status === "paid" || event.type === "checkout.session.async_payment_succeeded") {
        const record = JSON.stringify({
          session: session.id,
          paid_at: new Date((event.created || 0) * 1000).toISOString(),
          amount_total: session.amount_total,
          email: session.customer_details && session.customer_details.email || null,
          name: session.customer_details && session.customer_details.name || null,
        });
        await Promise.all(ids.map((id) => Promise.all([
          env.SALES.put("sold:" + id, record),
          env.SALES.delete("reserved:" + id),
        ])));
      } else {
        // Paid later (bank debit etc). Keep the hold until Stripe confirms.
        await Promise.all(ids.map((id) => env.SALES.put("reserved:" + id, session.id, { expirationTtl: 7 * 24 * 3600 })));
      }
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      await Promise.all(ids.map(async (id) => {
        const holder = await env.SALES.get("reserved:" + id);
        if (holder === session.id) await env.SALES.delete("reserved:" + id);
      }));
      break;
    }
    default:
      break;
  }
  return json({ received: true }, 200);
}

export async function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300, now = Date.now()) {
  const parts = Object.create(null);
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i === -1) continue;
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1).trim();
    (parts[k] = parts[k] || []).push(v);
  }
  const t = parts.t && parts.t[0];
  const sigs = parts.v1 || [];
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, t + "." + payload);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/* ---------- Stripe REST ---------- */

async function stripe(env, method, path, params) {
  const res = await fetch("https://api.stripe.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? formEncode(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("stripe error", JSON.stringify(data));
    throw new Error((data.error && data.error.message) || "Stripe error");
  }
  return data;
}

export function formEncode(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
}

/* ---------- helpers ---------- */

function corsHeaders(origin, env) {
  const allowed = [
    env.SITE_ORIGIN || "https://getcrazycards.com",
    "https://www.getcrazycards.com",
    "https://ckline540.github.io",
  ];
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}
