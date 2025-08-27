import { Router } from "express";
import { validateLicence } from "../services/lemon.mjs";
const router = Router();

router.post("/license/validate", async (req, res) => {
  const { licenseKey } = req.body || {};
  if (!licenseKey) return res.status(400).json({ ok:false, error:"Missing licenseKey" });
  try {
    const result = await validateLicence(licenseKey);
    return res.json({ ok: result.ok });
  } catch {
    return res.status(500).json({ ok:false, error:"Validation failed" });
  }
});

export default router;
