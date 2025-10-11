import { Router, raw } from "express";
import crypto from "crypto";
import config from "../config/plans.config.mjs";
import { addCredits } from "../services/credits.mjs";
import { createClient } from "@supabase/supabase-js";

const router = Router();

// Supabase admin client (server-side)
const supabaseAdmin = createClient(
  process.env.PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// raw body here; mount at /api/webhooks/lemon
router.post("/webhooks/lemon", raw({ type: "*/*" }), async (req, res) => {
  try {
    // 🔐 Verify Lemon webhook signature
    const sig = req.get("x-signature") || "";
    const secret = process.env.LEMON_WEBHOOK_SECRET || "";
    const digest = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");
    if (
      !secret ||
      !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig, "hex"))
    ) {
      return res.status(400).send("Bad signature");
    }

    // 📨 Parse Lemon event
    const evt = JSON.parse(req.body.toString("utf8"));
    const type = evt?.meta?.event_name;
    const productId = String(
      evt?.data?.attributes?.product_id ||
        evt?.data?.relationships?.product?.data?.id ||
        ""
    );
    const email =
      evt?.data?.attributes?.user_email ||
      evt?.data?.attributes?.customer_email;
    const licenseKey =
      evt?.data?.attributes?.key || evt?.data?.attributes?.license_key;
    const eventId = evt?.meta?.event_id || null;

    // 🧩 Credit map based on your plans.config.mjs
    const map = {
      [config.PRODUCTS.BOOST25]: 25,
      [config.PRODUCTS.BOOST100]: 100,
      [config.PRODUCTS.BOOST250]: 250,
      [config.PRODUCTS.BOOST500]: 500,
      [config.PRODUCTS.STARTER]: config.BOOSTS.STARTER.credits,
      [config.PRODUCTS.CREATOR]: config.SUBSCRIPTIONS.CREATOR.monthlyCredits,
      [config.PRODUCTS.PRO]: config.SUBSCRIPTIONS.PRO.monthlyCredits,
      [config.PRODUCTS.FREE]: config.FREE.credits,
    };

    const delta = map[productId] || 0;

    // 💡 Helper: ensure Supabase user exists
    const ensureSupabaseUser = async (email) => {
      if (!email) return null;
      const { data: userList } = await supabaseAdmin.auth.admin.listUsers();
      const existing = userList?.users?.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase()
      );

      if (existing) return existing;

      // create new user and send magic link to log in instantly
      const { data: created } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
      });

      // send magic link login
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: { redirectTo: `${process.env.PUBLIC_APP_URL}/dashboard` },
      });

      return created;
    };

    // 🧠 Handle Free Plan: create account + give 5 credits
    if (
      productId === config.PRODUCTS.FREE &&
      ["order_created"].includes(type)
    ) {
      const user = await ensureSupabaseUser(email);
      if (user?.user?.id) {
        await addCredits(
          user.user.id,
          config.FREE.credits,
          "free_plan_signup",
          eventId
        );
      }
      return res.status(200).send("Free plan processed");
    }

    // 🪙 Handle paid orders & subscriptions
    if (
      licenseKey &&
      delta > 0 &&
      ["order_created", "subscription_created", "subscription_renewed"].includes(
        type
      )
    ) {
      await addCredits(licenseKey, delta, type, eventId);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Lemon webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

export default router;
