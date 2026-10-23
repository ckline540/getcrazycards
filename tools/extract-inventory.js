#!/usr/bin/env node
/**
 * Publishes inventory.json (no photos) from the inventory embedded in index.html.
 * The checkout worker reads this file to price the cart, so run it after every
 * inventory change:   node tools/extract-inventory.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const m = html.match(/<script type="application\/json" id="inventory-data">([\s\S]*?)<\/script>/);
if (!m) { console.error("inventory-data block not found in index.html"); process.exit(1); }

const cards = JSON.parse(m[1]).map((c) => ({
  id: c.id, player: c.player, card: c.card, set_year: c.set_year, card_number: c.card_number,
  parallel: c.parallel, team: c.team, sport: c.sport, graded: !!c.graded, grade: c.grade,
  price: Number(c.price) || 0, status: c.status || "sell",
}));

const out = { generated_at: new Date().toISOString(), count: cards.length, cards };
fs.writeFileSync(path.join(root, "inventory.json"), JSON.stringify(out, null, 1) + "\n");
const forSale = cards.filter((c) => c.status === "sell" && c.price > 0).length;
console.log("inventory.json written: " + cards.length + " cards, " + forSale + " for sale");
