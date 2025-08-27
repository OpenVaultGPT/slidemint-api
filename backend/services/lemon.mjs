export async function validateLicence(licenseKey) {
  const body = new URLSearchParams();
  body.set("license_key", licenseKey);

  const res = await fetch("https://api.lemonsqueezy.com/v1/licenses/validate", {
    method: "POST",
    headers: { Accept: "application/json" },
    body
  });

  const data = await res.json().catch(() => ({}));
  return { ok: !!data?.valid, raw: data };
}
