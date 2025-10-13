import config from "../config/plans.config.mjs";
import { consumeCredits } from "../services/credits.mjs";

export default function creditsGuard(action = "video1080p") {
  return async (req, res, next) => {
    try {
      const cost = config.CREDIT_COST[action] ?? 1;
      const licenseKey = req.licenseKey;
      const out = await consumeCredits(licenseKey, cost, req.body?.jobId || null);
      if (!out.ok) return res.status(402).json({ ok:false, error:"Not enough credits", remaining: out.remaining });
      next();
    } catch {
      return res.status(500).json({ ok:false, error:"Credit check failed" });
    }
  };
}
