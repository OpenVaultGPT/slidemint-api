// Import required modules
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Required for ES module resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// App setup
const app = express();
app.use(cors());
app.use(express.json());

// Endpoint to process image slideshow
app.post('/process', async (req, res) => {
  const { imageUrls, duration, textOverlay } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'Invalid image URLs' });
  }

  try {
    const tempDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    // Download images
    const imagePaths = await Promise.all(
      imageUrls.map(async (url) => {
        const filename = `${uuidv4()}.jpg`;
        const filepath = path.join(tempDir, filename);
        const writer = fs.createWriteStream(filepath);
        const response = await axios.get(url, { responseType: 'stream' });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        return filepath;
      })
    );

    // Generate output path
    const outputFile = path.join(tempDir, `${uuidv4()}.mp4`);
    let ffmpegCommand = ffmpeg();

    // Add images as input
    imagePaths.forEach((imgPath) => {
      ffmpegCommand = ffmpegCommand.input(imgPath).inputOptions('-loop 1');
    });

    // Set duration and output options
    ffmpegCommand
      .inputOptions(`-t ${duration}`)
      .complexFilter(
        textOverlay
          ? [
              `drawtext=text='${textOverlay}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=h-50`
            ]
          : []
      )
      .on('end', () => {
        res.download(outputFile, () => {
          // Clean up
          imagePaths.forEach((p) => fs.unlinkSync(p));
          fs.unlinkSync(outputFile);
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err.message);
        res.status(500).json({ error: 'Video processing failed' });
        // Clean up
        imagePaths.forEach((p) => fs.unlinkSync(p));
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
      })
      .save(outputFile);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Promo Genie API running on port ${PORT}`);
});
