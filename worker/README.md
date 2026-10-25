# Crazy Cards checkout worker

A small Cloudflare Worker that lets the static shop at getcrazycards.com take real payments through Stripe Checkout.

What it does:

- `POST /checkout` takes the card ids in the cart, prices them from `inventory.json` on the main branch (read through raw.githubusercontent.com), creates a Stripe Checkout Session (card payment, US shipping address, flat shipping) and returns the Stripe URL. Each card is held for 30 minutes while that checkout is open.
- `POST /webhook` receives Stripe events. A paid session marks its cards sold forever. An expired or failed session releases the hold.
- `GET /sold` returns `{ sold: [...], reserved: [...] }`. The shop calls it on load and shows SOLD / IN CHECKOUT badges.

## One-time setup

1. Install Node (already on this Mac) and sign in to Cloudflare:
   `cd worker && npm install && npx wrangler login`
2. Create the KV namespace and paste the printed id into `wrangler.toml`:
   `npx wrangler kv namespace create SALES`
3. Add the Stripe secret key (Stripe Dashboard > Developers > API keys). A restricted key with write access to Checkout Sessions is enough:
   `npx wrangler secret put STRIPE_SECRET_KEY`
4. Deploy: `npx wrangler deploy`. Note the URL it prints, for example `https://crazycards-checkout.<account>.workers.dev`.
5. In Stripe Dashboard > Developers > Webhooks, add an endpoint at `<worker url>/webhook` listening to
   `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`.
   Copy its signing secret and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. Put the worker URL into `index.html` where it says `CHECKOUT_API` (already set to https://crazycards-checkout.crazycards.workers.dev), then push.

## Every inventory change

Edit the inventory in `index.html`, then run `node tools/extract-inventory.js` so `inventory.json` matches, and push both.

## Shipping settings

Edit `[vars]` in `wrangler.toml` and redeploy: `SHIPPING_CENTS` (flat rate), `FREE_SHIPPING_OVER_CENTS` (0 = never free), `SHIPPING_LABEL`, `ALLOWED_COUNTRIES`.

## Tests

`node test.mjs` checks webhook signature verification. `node test-flow.mjs` runs a full mocked buy: checkout, second shopper blocked, webhook marks sold, expired session releases the hold.
