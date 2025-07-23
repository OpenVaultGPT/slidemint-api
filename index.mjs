import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;

app.post('/generate', async (req, res) => {
  try {
    const { imageUrls, duration = 1.5 } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'Missing or invalid imageUrls array.' });
    }

    const tempDir = path.join(os.tmpdir(), uuidv4());
    fs.mkdirSync(tempDir);

    const downloaded = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      const filename = path.join(tempDir, `img${i}.jpg`);
      const response = await fetch(imgUrl);
      const buffer = await response.buffer();
      fs.writeFileSync(filename, buffer);
      downloaded.push(filename);
    }

    const outPath = path.join(tempDir, 'tiktok-style.mp4');
    const command = ffmpeg();

    downloaded.forEach(img => {
      command.input(img).loop(duration);
    });

    command
      .inputOptions('-framerate 1')
      .videoCodec('libx264')
      .size('1080x1920')
      .outputOptions('-pix_fmt yuv420p')
      .on('end', () => {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="tiktok-style.mp4"');
        const stream = fs.createReadStream(outPath);
        stream.pipe(res);
      })
      .on('error', err => {
        console.error(err);
        res.status(500).json({ error: 'Video processing failed.' });
      })
      .save(outPath);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log(`Promo Genie API running on port ${PORT}`);
});
