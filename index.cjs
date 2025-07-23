const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

app.post("/generate", async (req, res) => {
  const { imageUrls, duration = 1.5, textOverlay } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: "imageUrls must be a non-empty array." });
  }

  const folder = path.join(__dirname, "temp", uuidv4());
  fs.mkdirSync(folder, { recursive: true });

  try {
    const downloadedFiles = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const filename = path.join(folder, `img${i}.jpg`);
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { "User-Agent": "PromoGenieBot/1.0" },
      });
      fs.writeFileSync(filename, response.data);
      downloadedFiles.push(filename);
    }

    const outputPath = path.join(folder, "output.mp4");

    const ffmpegCommand = ffmpeg();

    downloadedFiles.forEach((file) => {
      ffmpegCommand.input(file).loop(duration);
    });

    ffmpegCommand
      .inputOptions("-y")
      .outputOptions([
        "-preset veryfast",
        "-tune stillimage",
        "-r 30", // 30 fps for TikTok style
        "-vf scale=720:1280,format=yuv420p", // vertical video
      ])
      .on("end", () => {
        res.download(outputPath, "promo-video.mp4", () => {
          fs.rmSync(folder, { recursive: true, force: true });
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Video generation failed." });
        fs.rmSync(folder, { recursive: true, force: true });
      })
      .save(outputPath);

  } catch (err) {
    console.error("Processing error:", err.message);
    res.status(500).json({ error: "Internal server error." });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

app.get("/", (req, res) => {
  res.send("Promo Genie API is running!");
});

app.listen(PORT, () => {
  console.log(`✅ Promo Genie API running on port ${PORT}`);
});

