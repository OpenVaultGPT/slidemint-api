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
  const slideDuration = duration || 1.5;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: "Missing or invalid imageUrls" });
  }

  const folder = path.join(__dirname, "temp", uuidv4());
  fs.mkdirSync(folder, { recursive: true });

  try {
    const downloadedFiles = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const imgPath = path.join(folder, `img${i}.jpg`);
      const response = await axios.get(imageUrls[i], {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "PromoGenieBot/1.0",
        },
      });
      fs.writeFileSync(imgPath, response.data);
      downloadedFiles.push(imgPath);
    }

    const fileListTxt = path.join(folder, "filelist.txt");
    const listData = downloadedFiles
      .map((f) => `file '${f}'\nduration ${slideDuration}`)
      .join("\n");
    fs.writeFileSync(fileListTxt, listData + `\nfile '${downloadedFiles.at(-1)}'`);

    const outputPath = path.join(folder, "slideshow.mp4");

    ffmpeg()
      .input(fileListTxt)
      .inputOptions("-f", "concat", "-safe", "0")
      .videoCodec("libx264")
      .outputOptions([
        "-vf",
        "scale=720:1280,format=yuv420p",
        "-r 30",
        "-preset veryfast",
      ])
      .on("end", () => {
        res.download(outputPath, "tiktok-style.mp4", () => {
          fs.rmSync(folder, { recursive: true, force: true });
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        res.status(500).json({ error: "Video generation failed" });
        fs.rmSync(folder, { recursive: true, force: true });
      })
      .save(outputPath);
  } catch (err) {
    console.error("Processing error:", err.message);
    res.status(500).json({ error: "Internal server error" });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

app.listen(PORT, () => {
  console.log(`Promo Genie API running on port ${PORT}`);
});
