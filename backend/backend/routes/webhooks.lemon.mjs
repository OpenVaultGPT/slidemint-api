import { Router, raw } from "express";
import crypto from "crypto";
import config from "../config/plans.config.mjs";
import { addCredits } from "../services/credits.mjs";

const router = Router();

// raw body here; mount at /api/webhooks/lemon
router.post("/webhooks/lemon", raw({ type: "*/*" }), async (req, res) => {
  const sig = req.get("x-signature") || "";
  const secret = process.env.LEMON_WEBHOOK_SECRET || "";
  const digest = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!secret || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig, "hex"))) {
    return res.status(400).send("Bad signature");
  }

  const evt = JSON.parse(req.body.toString("utf8"));
  const type = evt?.meta?.event_name;
  const lic = evt?.data?.attributes?.key || evt?.data?.attributes?.license_key;
  const productId = String(evt?.data?.attributes?.product_id || evt?.data?.relationships?.product?.data?.id || "");

  const map = {
    [config.PRODUCTS.BOOST100]: 100,
    [config.PRODUCTS.BOOST250]: 250,
    [config.PRODUCTS.BOOST500]: 500,
    [config.PRODUCTS.PRO]:      config.SUBSCRIPTIONS.PRO.monthlyCredits,
    [config.PRODUCTS.BUSINESS]: config.SUBSCRIPTIONS.BUSINESS.monthlyCredits
  };

  const delta = map[productId] || 0;
  if (lic && delta > 0 && ["order_created","subscription_created","subscription_renewed"].includes(type)) {
    await addCredits(lic, delta, type, evt.meta?.event_id || null);
  }
  res.status(200).send("ok");
});

export default router;
