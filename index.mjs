import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const app = express();
app.use(express.json());
const execAsync = promisify(exec);

app.post('/generate', async (req, res) => {
  const { imageUrls, duration } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).send('No image URLs provided.');
  }

  const timestamp = Date.now();
  const tmpDir = `/tmp/promo_${timestamp}`;
  const inputPath = path.join(tmpDir, 'input.txt');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    const lines = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const imgPath = path.join(tmpDir, `img${i}.jpg`);

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.ebay.co.uk/' // Helps bypass restrictions
          }
        });

        if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

        const buffer = await response.buffer();
        await fs.writeFile(imgPath, buffer);

        lines.push(`file '${imgPath}'`);
        lines.push(`duration ${duration}`);
      } catch (fetchErr) {
        console.warn(`⚠️ Skipping ${url} — ${fetchErr.message}`);
      }
    }

    if (lines.length === 0) {
      return res.status(400).send('No valid images could be fetched.');
    }

    // Repeat last frame so ffmpeg finalises properly
    lines.push(`file '${path.join(tmpDir, `img${lines.length / 2 - 1}.jpg`)}'`);

    await fs.writeFile(inputPath, lines.join('\n'));

    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i ${inputPath} -vsync vfr -pix_fmt yuv420p ${outputPath}`;
    await execAsync(ffmpegCmd);

    const video = await fs.readFile(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(video);
  } catch (err) {
    console.error('❌ Error in /generate handler:', err);
    res.status(500).send('Internal Server Error');
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Promo Genie API running on port ${port}`);
});
