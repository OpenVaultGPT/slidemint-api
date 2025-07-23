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
  const { imageUrls, duration } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls)) {
    return res.status(400).json({ error: "Invalid imageUrls format." });
  }

  const folder = path.join(__dirname, "temp", uuidv4());
  fs.mkdirSync(folder, { recursive: true });

  try {
    // Download images
    const downloadedFiles = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const filename = path.join(folder, `img${i}.jpg`);
      const response = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PromoGenieBot/1.0; +https://promo-genie-api.onrender.com)",
        },
      });
      fs.writeFileSync(filename, response.data);
      downloadedFiles.push(filename);
    }

    // Generate slideshow video
    const outputPath = path.join(folder, "output.mp4");
    const ffmpegCommand = ffmpeg();

    downloadedFiles.forEach((file) => {
      ffmpegCommand.input(file).loop(duration || 1.5);
    });

    ffmpegCommand
      .on("end", () => {
        res.download(outputPath, "tiktok-style.mp4", () => {
          fs.rmSync(folder, { recursive: true, force: true });
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        res.status(500).json({ error: "Video generation failed." });
        fs.rmSync(folder, { recursive: true, force: true });
      })
      .inputOptions("-y")
      .videoCodec("libx264")
      .outputOptions([
        "-preset veryfast",
        "-r 30",
        "-vf scale=1080:1920"
      ])
      .output(outputPath)
      .run();
  } catch (err) {
    console.error("Error during processing:", err.message);
    res.status(500).json({ error: "Internal server error." });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`Promo Genie API running on port ${PORT}`);
});
