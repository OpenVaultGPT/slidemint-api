import { validateLicence } from "../services/lemon.mjs";

export default async function licenseGuard(req, res, next) {
  try {
    const key = req.headers["x-license-key"] || req.query.licenseKey || req.body?.licenseKey;
    if (!key) return res.status(402).json({ ok:false, error:"License required" });

    const result = await validateLicence(key);
    if (!result.ok) return res.status(401).json({ ok:false, error:"Invalid license" });

    req.licenseKey = key;
    next();
  } catch {
    return res.status(500).json({ ok:false, error:"License check error" });
  }
}
