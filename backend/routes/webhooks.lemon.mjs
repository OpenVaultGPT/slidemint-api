import { Router, raw } from "express";
import crypto from "crypto";
import config from "../config/plans.config.mjs";
import { addCredits } from "../services/credits.mjs";
import { createClient } from "@supabase/supabase-js";

const router = Router();

// ✅ Environment setup
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LEMON_SECRET = process.env.LEMON_WEBHOOK_SECRET;
const APP_URL = process.env.PUBLIC_APP_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Supabase env vars missing");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// raw body here; mount at /api/webhooks/lemon
router.post("/webhooks/lemon", raw({ type: "*/*" }), async (req, res) => {
  try {
    // 🔐 Verify Lemon webhook signature
    const sig = req.get("x-signature") || "";
    if (!LEMON_SECRET) return res.status(400).send("Missing Lemon secret");

    const digest = crypto
      .createHmac("sha256", LEMON_SECRET)
      .update(req.body)
      .digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig, "hex"))) {
      return res.status(400).send("Bad signature");
    }

    // 📨 Parse Lemon event
    const evt = JSON.parse(req.body.toString("utf8"));
    const type = evt?.meta?.event_name;
    const productId =
      String(evt?.data?.attributes?.product_id || "") ||
      evt?.data?.relationships?.product?.data?.id ||
      "";
    const email =
      evt?.data?.attributes?.user_email ||
      evt?.data?.attributes?.customer_email;
    const eventId = evt?.meta?.event_id || null;

    // 🧩 Credit map from config
    const ensureNumber = (value) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0;

    const creditConfig = {
      BOOST25: ensureNumber(config.BOOSTS?.BOOST25?.credits ?? 25),
      BOOST100: ensureNumber(config.BOOSTS?.BOOST100?.credits ?? 100),
      BOOST250: ensureNumber(config.BOOSTS?.BOOST250?.credits ?? 250),
      BOOST500: ensureNumber(config.BOOSTS?.BOOST500?.credits ?? 500),
      STARTER: ensureNumber(config.BOOSTS?.STARTER?.credits),
      CREATOR: ensureNumber(config.SUBSCRIPTIONS?.CREATOR?.monthlyCredits),
      PRO: ensureNumber(config.SUBSCRIPTIONS?.PRO?.monthlyCredits),
      FREE: ensureNumber(config.SUBSCRIPTIONS?.FREE?.credits),
    };

    const map = Object.entries(creditConfig).reduce((acc, [productKey, credits]) => {
      const productId = config.PRODUCTS?.[productKey];

      if (typeof productId === "string" && productId.length > 0) {
        acc[productId] = credits;
      }

      return acc;
    }, {});

    const delta = map[productId] || 0;

    // 🧠 Ensure Supabase user exists + trigger magic link
    const ensureSupabaseUser = async (email) => {
      if (!email) return null;

      const { data, error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${APP_URL}/dashboard` },
      });

      if (error) console.error("⚠️ Error sending magic link:", error.message);
      else console.log(`📧 Magic link sent to ${email}`);
    };

    // 🪙 Free Plan: auto-create user & send login link
    if (productId === config.PRODUCTS.FREE && type === "order_created") {
      console.log(`🆓 Free plan signup for ${email}`);
      await ensureSupabaseUser(email);
      return res.status(200).send("Free plan processed");
    }

    // 💳 Paid Plans: credit top-up
    if (delta > 0 && email && ["order_created", "subscription_renewed"].includes(type)) {
      // find user by email
      const { data: users } = await supabase.auth.admin.listUsers();
      const user = users?.users?.find(
        (u) => u.email?.toLowerCase() === email.toLowerCase()
      );

      if (user?.id) {
        await addCredits(user.id, delta, type, eventId);
        console.log(`💰 Added ${delta} credits to ${email}`);
      } else {
        console.warn(`⚠️ No Supabase user found for ${email}`);
        await ensureSupabaseUser(email);
      }

      return res.status(200).send("Credits added");
    }

    return res.status(200).send("Event ignored");
  } catch (err) {
    console.error("🔥 Lemon webhook error:", err);
    res.status(500).send("Webhook error");
  }
});

export default router;
