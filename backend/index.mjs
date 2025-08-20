import express from 'express';
// REMOVED node-canvas entirely
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
app.use(express.json({ limit: '5mb' })); // a bit more headroom

// ---- config ----
const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 60000);

// Target video frame (HD landscape for eBay)
const FRAME_W = 1280;
const FRAME_H = 720;
const FPS = 30;

// ✅ Healthcheck
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// 📥 Fetch bytes with timeout
async function fetchBuffer(url, tMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), tMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.buffer();
  } finally {
    clearTimeout(t);
  }
}

// 🖼️ Make one 1280x720 JPG frame via sharp (contain + pad)
async function makeFrameFromUrl(url, outPath) {
  try {
    const buf = await fetchBuffer(url, 8000);
    await sharp(buf)
      .resize({ width: FRAME_W, height: FRAME_H, fit: 'contain', withoutEnlargement: false, background: '#000' })
      .jpeg({ quality: 92, mozjpeg: true })
      .toFile(outPath);
  } catch (e) {
    // Fallback: solid placeholder frame (no text to avoid heavy compositing)
    await sharp({
      create: { width: FRAME_W, height: FRAME_H, channels: 3, background: '#111' }
    })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(outPath);
    console.error('Frame fallback for URL:', url, '-', e.message);
  }
}

// 🎞️ Build slideshow: write JPEG frames, then ffmpeg -> mp4
async function createSlideshow(images, outputPath, duration = 2) {
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  try {
    // 1) Frames
    for (let i = 0; i < images.length; i++) {
      const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.jpg`);
      console.log(`🖼️ [${i + 1}/${images.length}] ${images[i]}`);
      await makeFrameFromUrl(images[i], framePath);
    }

    // 2) Encode
    const inputFps = 1 / duration;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tempFramesDir, 'frame-%03d.jpg'))
        .inputOptions(['-framerate', inputFps.toFixed(6)]) // reliable form
        .videoCodec('libx264')
        .outputOptions([
          `-r ${FPS}`,
          '-pix_fmt yuv420p',
          '-profile:v high',
          '-level 4.1',
          '-g 60',
          '-bf 2',
          '-movflags +faststart',
          '-crf 18',
          '-maxrate 8M',
          '-bufsize 16M',
          '-colorspace bt709',
          '-color_primaries bt709',
          '-color_trc bt709',
          '-preset medium',
        ])
        .on('start', cmd => console.log('🎬 FFmpeg:', cmd))
        .on('stderr', line => console.log('📦 FFmpeg:', line))
        .on('end', resolve)
        .on('error', err => {
          console.error('❌ FFmpeg error:', err?.message || err);
          reject(err);
        })
        .save(outputPath);
    });
  } finally {
    fs.rmSync(tempFramesDir, { recursive: true, force: true });
  }
}

// 🔁 Direct generate (used by PD)
app.post('/generate', async (req, res) => {
  try {
    const { imageUrls, duration } = req.body || {};
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid image URLs' });
    }

    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });

    const videoFilename = `video-${uuidv4()}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await createSlideshow(imageUrls, outputPath, Number(duration) || 2);

    const videoUrl = `https://slidemint-api.onrender.com/videos/${videoFilename}`;
    return res.status(200).json({ videoUrl });
  } catch (err) {
    console.error('🔻 /generate failed:', err?.stack || err?.message || err);
    // Always return JSON so PD never sees an HTML 502
    return res.status(500).json({ error: 'Video generation failed', detail: String(err?.message || err) });
  }
});

// 🚀 Launch server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SlideMint backend listening on :${PORT}`));
