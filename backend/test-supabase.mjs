import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/debug-auth", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(400).json({ error: "Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired token", details: error });
    }

    res.json({
      ok: true,
      user: {
        id: data.user.id,
        email: data.user.email,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal test error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Test running on port ${PORT}`));
