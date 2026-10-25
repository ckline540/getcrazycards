import { verifyStripeSignature, formEncode } from "./src/index.js";
import { createHmac } from "node:crypto";

let failed = 0;
function check(name, cond) { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failed++; }

const secret = "whsec_testsecret";
const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
const t = Math.floor(Date.now() / 1000);
const good = createHmac("sha256", secret).update(t + "." + payload).digest("hex");

check("valid signature accepted", await verifyStripeSignature(payload, `t=${t},v1=${good}`, secret));
check("tampered payload rejected", !(await verifyStripeSignature(payload + " ", `t=${t},v1=${good}`, secret)));
check("wrong secret rejected", !(await verifyStripeSignature(payload, `t=${t},v1=${good}`, "whsec_other")));
check("stale timestamp rejected", !(await verifyStripeSignature(payload, `t=${t - 1000},v1=${good}`, secret)));
check("missing v1 rejected", !(await verifyStripeSignature(payload, `t=${t}`, secret)));

const enc = formEncode({ mode: "payment", "line_items[0][quantity]": 1, skip: undefined });
check("form encoding brackets", enc === "mode=payment&line_items%5B0%5D%5Bquantity%5D=1");

process.exit(failed ? 1 : 0);
