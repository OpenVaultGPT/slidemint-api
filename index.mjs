import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const app = express();
app.use(express.json({ limit: '10mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

app.post('/generate', async (req, res) => {
  try {
    const { imageUrls, duration = 1.5 } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'Missing or invalid imageUrls array.' });
    }

    const tempDir = path.join(tmpdir(), uuidv4());
    fs.mkdirSync(tempDir);

    const downloaded = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const filename = path.join(tempDir, `img${i}.jpg`);
      const response = await fetch(url);
      const buffer = await response.buffer();
      fs.writeFileSync(filename, buffer);
      downloaded.push(filename);
    }

    const outputPath = path.join(tempDir, `slideshow.mp4`);
    const command = ffmpeg();

    downloaded.forEach(img => {
      command.input(img).loop(duration);
    });

    command
      .inputOptions('-framerate 1')
      .videoCodec('libx264')
      .size('1080x1920')
      .format('mp4')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-r 30',
        '-movflags +faststart'
      ])
      .on('end', () => {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', 'attachment; filename="tiktok-style.mp4"');
        const stream = fs.createReadStream(outputPath);
        stream.pipe(res).on('finish', () => {
          fs.rmSync(tempDir, { recursive: true, force: true });
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
        res.status(500).json({ error: 'Video generation failed.' });
      })
      .save(outputPath);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.get('/', (req, res) => {
  res.send('Promo Genie API running...');
});

app.listen(PORT, () => {
  console.log(`Promo Genie API running on port ${PORT}`);
});
