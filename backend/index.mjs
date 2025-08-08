import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 🔐 Allow requests from frontend only
app.use(cors({ origin: 'https://app.slidemint.openvaultgpt.com' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ✅ Healthcheck endpoint
app.get('/health', (_, res) => res.status(200).send('OK'));

// 📥 Fetch and resize image safely
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();
    const resized = await sharp(buffer).resize({ width: 720 }).png().toBuffer();
    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed to process image: ${url}`, err.message);
    return null;
  }
}

// 🎞️ Create slideshow video from image list
async function createSlideshow(images, outputPath, duration = 2) {
  const width = 720;
  const height = 1280;
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  for (let i = 0; i < images.length; i++) {
    console.log(`🖼️ Rendering image ${i + 1}/${images.length}`);
    const img = await fetchImageAsCanvasImage(images[i]);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (img) {
      const aspect = img.width / img.height;
      let drawWidth = width;
      let drawHeight = width / aspect;
      if (drawHeight > height) {
        drawHeight = height;
        drawWidth = height * aspect;
      }
      const x = (width - drawWidth) / 2;
      const y = (height - drawHeight) / 2;
      ctx.drawImage(img, x, y, drawWidth, drawHeight);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ Image failed to load', width / 2, height / 2);
    }

    const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
  }

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(tempFramesDir, 'frame-%03d.png'))
      .inputOptions(['-stream_loop', '1', '-framerate', (1 / duration).toFixed(2)])
      .outputOptions([
        '-vf', 'scale=720:-2',
        '-r', '30',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
      ])
      .videoCodec('libx264')
      .save(outputPath)
      .on('start', cmd => console.log('🎬 FFmpeg started:', cmd))
      .on('stderr', line => console.log('📦 FFmpeg:', line))
      .on('end', () => {
        console.log('✅ FFmpeg finished');
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
        resolve();
      })
      .on('error', err => {
        console.error('❌ FFmpeg error:', err.message);
        reject(err);
      });
  });
}

// 🔁 Forward request to Pipedream → Render
app.post('/generate-proxy', async (req, res) => {
  const { itemId } = req.body;
  console.log('📩 Received itemId:', itemId);

  if (!itemId || !itemId.match(/^\d{9,12}$/)) {
    console.error('❌ Invalid itemId:', itemId);
    return res.status(400).json({ error: 'Invalid item ID' });
  }

  try {
    const pdRes = await fetch('https://eos21xm8bj17yt2.m.pipedream.net', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [itemId] }),
    });

    const contentType = pdRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await pdRes.text();
      console.error('❌ Pipedream returned non-JSON:', text.slice(0, 100));
      return res.status(500).json({ error: 'Pipedream did not return valid JSON' });
    }

    const data = await pdRes.json();
    const { videoUrl, cleanedUrls } = data;

    if (!videoUrl) {
      console.error('❌ No videoUrl in Pipedream response');
      return res.status(500).json({ error: 'Video not generated' });
    }

    return res.status(200).json({ videoUrl, cleanedUrls: cleanedUrls || [] });

  } catch (err) {
    console.error('❌ Proxy error:', err.stack || err.message);
    return res.status(500).json({ error: 'Pipedream request failed' });
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SlideMint backend running on port ${PORT}`);
});
