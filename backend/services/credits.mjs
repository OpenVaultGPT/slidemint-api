import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function addCredits(licenseKey, delta, reason, ref) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `insert into licences (license_key, credits_total, credits_used)
       values ($1, greatest($2,0), 0)
       on conflict (license_key) do update
         set credits_total = licences.credits_total + greatest($2,0), updated_at = now()`,
      [licenseKey, delta]
    );
    await c.query(`insert into credit_txns (license_key, delta, reason, ref) values ($1,$2,$3,$4)`,
      [licenseKey, delta, reason, ref || null]);
    await c.query("COMMIT");
  } finally { c.release(); }
}

export async function consumeCredits(licenseKey, amount, ref) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      `select credits_total, credits_used from licences where license_key=$1 for update`,
      [licenseKey]
    );
    if (!rows.length) { await c.query("ROLLBACK"); return { ok:false, remaining:0 }; }
    const { credits_total, credits_used } = rows[0];
    const remaining = credits_total - credits_used;
    if (remaining < amount) { await c.query("ROLLBACK"); return { ok:false, remaining }; }
    await c.query(`update licences set credits_used = credits_used + $2, updated_at = now() where license_key=$1`,
      [licenseKey, amount]);
    await c.query(`insert into credit_txns (license_key, delta, reason, ref) values ($1,$2,$3,$4)`,
      [licenseKey, -amount, "consume", ref || null]);
    await c.query("COMMIT");
    return { ok:true, remaining: remaining - amount };
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch {}
    throw e;
  } finally { c.release(); }
}
