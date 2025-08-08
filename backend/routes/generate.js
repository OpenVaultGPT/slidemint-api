// /routes/generate.js
const express = require("express");
const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { imageUrls, duration } = req.body;

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: "Missing or invalid image URLs" });
    }

    console.log("✅ Received image URLs:", imageUrls);

    // 🧪 TEMP: Fake video URL response until your render logic is hooked
    const fakeVideoUrl = "https://example.com/video.mp4";

    return res.json({
      videoUrl: fakeVideoUrl,
      cleanedUrls: imageUrls
    });
  } catch (err) {
    console.error("❌ Error in /generate:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
