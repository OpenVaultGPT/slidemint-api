import express from "express";
import ffmpeg from "fluent-ffmpeg";
import axios from "axios";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

app.post("/process", async (req, res) => {
  const { imageUrls, duration, textOverlay } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: "Invalid image URLs" });
  }

  const tempDir = "./tmp";
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const imageFiles = await Promise.all(
    imageUrls.map(async (url, index) => {
      const imagePath = `${tempDir}/${uuidv4()}.jpg`;
      const writer = fs.createWriteStream(imagePath);
      const response = await axios({ url, method: "GET", responseType: "stream" });
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      return imagePath;
    })
  );

  const outputFile = `${tempDir}/${uuidv4()}.mp4`;
  const ffmpegProcess = ffmpeg();

  imageFiles.forEach((file) => ffmpegProcess.input(file).inputOptions("-loop 1").inputOptions(`-t ${duration}`));

  ffmpegProcess
    .on("end", () => {
      imageFiles.forEach(fs.unlinkSync);
      res.download(outputFile, () => fs.unlinkSync(outputFile));
    })
    .on("error", (err) => {
      console.error("FFmpeg error:", err);
      res.status(500).json({ error: "Video processing failed" });
    })
    .videoCodec("libx264")
    .outputOptions("-pix_fmt yuv420p")
    .save(outputFile);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PromoGenie API running on port ${PORT}`));
