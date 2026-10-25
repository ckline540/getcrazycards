import worker from "./src/index.js";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const inventory = JSON.parse(readFileSync(new URL("../inventory.json", import.meta.url), "utf8"));
const kvStore = new Map();
const SALES = {
  async get(k) { return kvStore.has(k) ? kvStore.get(k) : null; },
  async put(k, v) { kvStore.set(k, v); },
  async delete(k) { kvStore.delete(k); },
  async list({ prefix }) { return { keys: [...kvStore.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
};
const env = { SALES, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_fake", SHIPPING_CENTS: "499", FREE_SHIPPING_OVER_CENTS: "5000", ALLOWED_COUNTRIES: "US" };

let lastStripeBody = null;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("inventory.json")) return new Response(JSON.stringify(inventory));
  if (String(url).includes("api.stripe.com")) {
    lastStripeBody = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }));
  }
  throw new Error("unexpected fetch " + url);
};

let failed = 0;
const check = (n, c) => { console.log((c ? "ok   " : "FAIL ") + n); if (!c) failed++; };
const call = (path, init, origin = "https://getcrazycards.com") =>
  worker.fetch(new Request("https://x.workers.dev" + path, { ...init, headers: { Origin: origin, "Content-Type": "application/json", ...(init && init.headers) } }), env, {});

// checkout for two real cards
let r = await call("/checkout", { method: "POST", body: JSON.stringify({ ids: ["cc-001", "cc-059"] }) });
let d = await r.json();
check("checkout returns stripe url", r.status === 200 && d.url.startsWith("https://checkout.stripe.com"));
check("cors echoes site origin", r.headers.get("Access-Control-Allow-Origin") === "https://getcrazycards.com");
check("line item 0 is Giannis at $15.00", lastStripeBody.get("line_items[0][price_data][unit_amount]") === "1500" && /Giannis/.test(lastStripeBody.get("line_items[0][price_data][product_data][name]")));
check("line item 1 is $600.00", lastStripeBody.get("line_items[1][price_data][unit_amount]") === "60000");
check("free shipping over $50", lastStripeBody.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "0");
check("US shipping address collected", lastStripeBody.get("shipping_address_collection[allowed_countries][0]") === "US");
check("cards reserved in KV", kvStore.get("reserved:cc-001") === "cs_test_123");

// cheap cart pays shipping
await call("/checkout", { method: "POST", body: JSON.stringify({ ids: ["cc-003"] }) });
check("small cart charges $4.99 shipping", lastStripeBody.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "499");

// second shopper tries a reserved card
r = await call("/checkout", { method: "POST", body: JSON.stringify({ ids: ["cc-001", "cc-004"] }) });
d = await r.json();
check("reserved card rejected with 409", r.status === 409 && d.unavailable.join() === "cc-001");

// collection-only and bogus ids rejected
r = await call("/checkout", { method: "POST", body: JSON.stringify({ ids: ["cc-092", "nope", "<script>"] }) });
d = await r.json();
check("not-for-sale and unknown ids rejected", r.status === 409 && d.unavailable.join() === "cc-092,nope");

// webhook marks sold
const evt = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
  data: { object: { id: "cs_test_123", payment_status: "paid", amount_total: 61500, metadata: { card_ids: "cc-001,cc-059" }, customer_details: { email: "buyer@example.com", name: "Buyer" } } } });
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", "whsec_fake").update(t + "." + evt).digest("hex");
r = await call("/webhook", { method: "POST", body: evt, headers: { "Stripe-Signature": `t=${t},v1=${sig}` } });
check("webhook accepted", r.status === 200);
check("cards marked sold, hold cleared", kvStore.has("sold:cc-001") && kvStore.has("sold:cc-059") && !kvStore.has("reserved:cc-001"));
r = await call("/webhook", { method: "POST", body: evt, headers: { "Stripe-Signature": `t=${t},v1=deadbeef` } });
check("forged webhook rejected", r.status === 400);

// expired session releases hold
const exp = JSON.stringify({ id: "evt_2", type: "checkout.session.expired", created: t, data: { object: { id: "cs_test_123", metadata: { card_ids: "cc-003" } } } });
r = await call("/webhook", { method: "POST", body: exp, headers: { "Stripe-Signature": `t=${t},v1=${createHmac("sha256", "whsec_fake").update(t + "." + exp).digest("hex")}` } });
check("expired session releases reservation", r.status === 200 && !kvStore.has("reserved:cc-003"));

// /sold lists
r = await call("/sold");
d = await r.json();
check("/sold lists sold ids", d.sold.sort().join() === "cc-001,cc-059" && d.reserved.length === 0);

// sold card cannot be bought again
r = await call("/checkout", { method: "POST", body: JSON.stringify({ ids: ["cc-059"] }) });
check("sold card rejected", r.status === 409);

process.exit(failed ? 1 : 0);
