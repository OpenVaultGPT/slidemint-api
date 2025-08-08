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
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ✅ Healthcheck
app.get('/health', (_, res) => res.status(200).send('OK'));

// 📥 Safe image fetch + resize
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

// 🎞️ Build slideshow
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

// 🔁 POST /generate-proxy → calls Pipedream → waits for Render
app.post("/generate-proxy", async (req, res) => {
  try {
    const { itemId } = req.body;
    const cleanId = itemId?.match(/\d{9,12}/)?.[0];

    if (!cleanId) {
      return res.status(400).json({ error: "Invalid eBay item ID" });
    }

    const pdRes = await fetch("https://eos21xm8bj17yt2.m.pipedream.net", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [cleanId] })
    });

    const contentType = pdRes.headers.get("content-type") || "";
    const isJSON = contentType.includes("application/json");

    if (!isJSON) {
      const fallback = await pdRes.text();
      console.log("📦 Raw Pipedream response text:", text.slice(0, 500));
      return res.status(500).json({
        error: "Pipedream returned non-JSON (HTML or error)",
        fallback: fallback.slice(0, 300)
      });
    }

    let data;
    try {
      const text = await pdRes.text();
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      console.error("❌ Failed to parse JSON from Pipedream:", err.message);
      return res.status(500).json({ error: "Malformed JSON from Pipedream" });
    }

    console.log("✅ Clean JSON from Pipedream:", data);

    const videoUrl = data.videoUrl || data.placeholderVideoUrl || null;
    const cleanedUrls = Array.isArray(data.cleanedUrls) ? data.cleanedUrls : [];

    if (!videoUrl || !videoUrl.startsWith("http")) {
      return res.status(500).json({ error: "Invalid or missing videoUrl" });
    }

    return res.status(200).json({ videoUrl, cleanedUrls });
  } catch (err) {
    console.error("🔥 Final error in /generate-proxy:", err.stack || err.message);
    return res.status(500).json({ error: "Internal proxy error" });
  }
});

// ✅ POST /generate → called directly with images[]
app.post("/generate", async (req, res) => {
  const { imageUrls, duration } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid image URLs' });
  }

  try {
    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });

    const videoFilename = `video-${uuidv4()}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await createSlideshow(imageUrls, outputPath, duration || 2);

    const videoUrl = `https://slidemint-api.onrender.com/videos/${videoFilename}`;
    return res.status(200).json({ videoUrl });
  } catch (err) {
    console.error('❌ Error generating video:', err.stack || err.message);
    return res.status(500).json({ error: 'Video generation failed' });
  }
});

// 🚀 Launch server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SlideMint backend running on port ${PORT}`);
});
