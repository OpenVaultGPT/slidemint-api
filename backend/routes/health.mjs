import express from "express";

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    const mustHave = [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "LEMONSQUEEZY_STORE_ID",
      "LEMON_API_KEY",
    ];
    const missing = mustHave.filter((k) => !process.env[k]);

    const info = {
      ok: missing.length === 0,
      missing,
      env: {
        APP_URL: process.env.APP_URL || null,
        RENDER_BASE_URL: process.env.RENDER_BASE_URL || null,
        SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "missing",
        LEMONSQUEEZY_STORE_ID: process.env.LEMONSQUEEZY_STORE_ID || null,
      },
      time: new Date().toISOString(),
    };

    res.status(200).json(info);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
