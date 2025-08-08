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
app.use(cors({ origin: 'https://app.slidemint.openvaultgpt.com' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 🔧 Safe fetch + resize
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();

    const resized = await sharp(buffer)
      .resize({ width: 720 })
      .png()
      .toBuffer();

    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed image: ${url} – ${err.message}`);
    return null;
  }
}

async function createSlideshow(images, outputPath, duration = 2) {
  const width = 720;
  const height = 1280;
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  for (let i = 0; i < images.length; i++) {
    console.log(`🖼️ Rendering image ${i + 1} of ${images.length}`);
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
    const inputs = path.join(tempFramesDir, 'frame-%03d.png');

    const command = ffmpeg()
      .input(inputs)
      .inputOptions([
        '-stream_loop', '1',
        '-framerate', (1 / duration).toFixed(2)
      ])
      .outputOptions([
        '-vf', 'scale=720:-2',
        '-r', '30',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart'
      ])
      .videoCodec('libx264')
      .save(outputPath)
      .on('start', (cmd) => console.log('🎬 FFmpeg started:', cmd))
      .on('stderr', (line) => console.log('📦 FFmpeg:', line))
      .on('end', () => {
        console.log('✅ FFmpeg finished');
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ FFmpeg error:', err.message);
        reject(err);
      });
  });
}

// ✅ Existing route – direct video generation from images
// ✅ NEW route – forward itemId to Pipedream
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
      body: JSON.stringify({ items: [itemId] })
    });

    const data = await pdRes.json();

    console.log('📦 Response from Pipedream:', JSON.stringify(data, null, 2));

    const { videoUrl, cleanedUrls } = data;

    if (!videoUrl) {
      console.error('❌ No videoUrl in response from Pipedream');
      return res.status(500).json({ error: 'Video not generated' });
    }

    return res.status(200).json({
      videoUrl,
      cleanedUrls: cleanedUrls || []
    });

  } catch (err) {
    console.error('❌ Proxy error:', err.stack || err.message);
    return res.status(500).json({ error: 'Pipedream request failed' });
  }
});

// ✅ Existing route – scrape eBay listing and call /generate
app.post('/generate-from-ebay', async (req, res) => {
  const { items } = req.body;
  const itemId = items?.[0]?.match(/\d{9,12}/)?.[0];

  if (!itemId) {
    return res.status(400).json({ error: 'Invalid eBay item ID' });
  }

  try {
    const ebayUrl = `https://www.ebay.co.uk/itm/${itemId}`;
    const html = await fetch(ebayUrl).then(r => r.text());

    const imageMatches = [...html.matchAll(/"mediaList":[\s\S]*?"url":"(https:\/\/i\.ebayimg\.com\/[^"]+)"/g)];
    const urls = imageMatches.map(match => match[1].replace(/\\u0025/g, '%')).slice(0, 10);

    if (!urls.length) {
      return res.status(404).json({ error: 'No images found on listing' });
    }

    // Call your existing /generate endpoint internally
    const response = await fetch(`http://localhost:${PORT}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrls: urls })
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    console.error('❌ Failed to extract from eBay:', err.message);
    res.status(500).json({ error: 'eBay parsing failed' });
  }
});

// ✅ NEW route – forward itemId to Pipedream
app.post('/generate-proxy', async (req, res) => {
  const { itemId } = req.body;

  if (!itemId || !itemId.match(/^\d{9,12}$/)) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }

  try {
    const pdRes = await fetch('https://eos21xm8bj17yt2.m.pipedream.net', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [itemId] })
    });

    const data = await pdRes.json();

    if (!data.videoUrl) {
      return res.status(500).json({ error: 'Video not generated' });
    }

    res.status(200).json({
      videoUrl: data.videoUrl,
      cleanedUrls: data.cleanedUrls || []
    });

  } catch (err) {
    console.error('❌ Proxy error:', err.message);
    res.status(500).json({ error: 'Pipedream request failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SlideMint backend running on port ${PORT}`);
});
