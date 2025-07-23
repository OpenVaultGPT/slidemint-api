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

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const buffer = await response.buffer();
      await fs.writeFile(imgPath, buffer);

      lines.push(`file '${imgPath}'`);
      lines.push(`duration ${duration}`);
    }

    // Repeat last frame (needed for ffmpeg to end properly)
    lines.push(`file '${path.join(tmpDir, `img${imageUrls.length - 1}.jpg`)}'`);

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
