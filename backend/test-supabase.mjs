import fetch from "node-fetch";
globalThis.fetch = fetch;

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// 🔍 Print envs for debugging
console.log("Loaded SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("Loaded SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY?.slice(0, 10) + "...");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in environment!");
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

try {
  const { data, error } = await supabase.from("user_credits").select("count").limit(1);
  if (error) throw error;
  console.log("✅ Connected to Supabase! Query result:", data);
} catch (err) {
  console.error("❌ Connection test failed:", err.message);
}
