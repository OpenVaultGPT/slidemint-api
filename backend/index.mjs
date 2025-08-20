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
app.use(express.json({ limit: '1mb' }));

// ---- config ----
const PIPEDREAM_URL = process.env.PIPEDREAM_URL || 'https://eos21xm8bj17yt2.m.pipedream.net';
const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 60000);

// Target video frame (use 1280x720 if you prefer HD)
const FRAME_W = 1920;
const FRAME_H = 1080;
const FPS = 30;

// ✅ Healthcheck
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// 📥 Safe image fetch + PRE-FIT to exact 16:9 frame via sharp (best quality)
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();

    // Pre-fit to FRAME_W x FRAME_H using high-quality sharp scaler
    const fitted = await sharp(buffer)
      .resize({
        width: FRAME_W,
        height: FRAME_H,
        fit: 'contain',
        withoutEnlargement: false, // allow upscale here so *we* control scaling, not eBay
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .png()
      .toBuffer();

    return await loadImage(fitted);
  } catch (err) {
    console.error(`❌ Failed to process image: ${url}`, err.message);
    return null;
  }
}

// 🎞️ Build slideshow (landscape, fixed FPS; each image shows for `duration` seconds)
async function createSlideshow(images, outputPath, duration = 2) {
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  try {
    for (let i = 0; i < images.length; i++) {
      console.log(`🖼️ Rendering image ${i + 1}/${images.length}`);
      const img = await fetchImageAsCanvasImage(images[i]);

      const canvas = createCanvas(FRAME_W, FRAME_H);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, FRAME_W, FRAME_H);

      if (img) {
        // Already sized by sharp to FRAME_W x FRAME_H with proper letterboxing
        ctx.drawImage(img, 0, 0, FRAME_W, FRAME_H);
      } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, FRAME_W, FRAME_H);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 48px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⚠️ Image failed to load', FRAME_W / 2, FRAME_H / 2);
      }

      const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
      fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
    }

    // Input framerate = one frame per "duration" seconds
    const inputFps = 1 / duration;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tempFramesDir, 'frame-%03d.png'))
        .inputOptions([`-framerate ${inputFps.toFixed(6)}`])
        .videoCodec('libx264')
        .outputOptions([
          `-r ${FPS}`,             // constant 30 fps output
          '-pix_fmt yuv420p',
          '-profile:v high',
          '-level 4.1',
          '-g 60',                 // keyframe every 2s at 30fps
          '-bf 2',
          '-movflags +faststart',
          '-crf 18',               // 18–20 is good; lower = higher quality
          '-maxrate 8M',
          '-bufsize 16M',
          // keep colors in SDR 709 to avoid odd re-maps
          '-colorspace bt709',
          '-color_primaries bt709',
          '-color_trc bt709',
          // quality over speed; you can switch to "medium" if needed
          '-preset slow',
        ])
        .on('start', cmd => console.log('🎬 FFmpeg started:', cmd))
        .on('stderr', line => console.log('📦 FFmpeg:', line))
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
  } finally {
    fs.rmSync(tempFramesDir, { recursive: true, force: true });
  }
}

// ---- helpers for Pipedream proxy ----
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function parsePipedreamResponse(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();

  if (ct.includes('application/json')) {
    try {
      const json = await res.json();
      return { kind: 'json', status: res.status, body: json };
    } catch {}
  }

  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return { kind: 'json', status: res.status, body: json };
  } catch {
    return { kind: 'text', status: res.status, body: text };
  }
}

// 🔁 Proxy route (frontend ➜ backend ➜ Pipedream)
app.post('/generate-proxy', async (req, res) => {
  try {
    const { itemId, images, duration } = req.body || {};
    const cleanId = itemId?.match(/\d{9,12}/)?.[0];

    if (!cleanId && !(Array.isArray(images) && images.length)) {
      return res.status(400).json({
        ok: false,
        code: 'BAD_REQUEST',
        message: 'Provide a valid eBay itemId or images[].',
        detail: { received: Object.keys(req.body || {}) },
      });
    }

    const pdRes = await fetchWithTimeout(
      PIPEDREAM_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'SlideMint-API/1.0',
        },
        body: JSON.stringify(cleanId ? { items: [cleanId], duration } : { images, duration }),
      },
      FETCH_TIMEOUT_MS
    );

    const parsed = await parsePipedreamResponse(pdRes);

    if (parsed.kind === 'json' && pdRes.ok) {
      const videoUrl = parsed.body.videoUrl || parsed.body.placeholderVideoUrl || null;
      const cleanedUrls = Array.isArray(parsed.body.cleanedUrls) ? parsed.body.cleanedUrls : [];

      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        return res.status(502).json({
          ok: false,
          code: 'NO_VIDEO_URL',
          message: 'Missing or invalid videoUrl from Pipedream.',
          detail: { parsed: parsed.body },
          _meta: { source: 'pipedream', status: parsed.status },
        });
      }

      return res.status(200).json({
        ok: parsed.body.ok !== false,
        videoUrl,
        cleanedUrls,
        _meta: { source: 'pipedream', status: parsed.status },
      });
    }

    if (parsed.kind === 'json' && !pdRes.ok) {
      return res.status(502).json({
        ok: false,
        code: parsed.body.code || 'PIPEDREAM_ERROR',
        message: parsed.body.message || 'Pipedream responded with an error.',
        detail: parsed.body,
        _meta: { source: 'pipedream', status: parsed.status },
      });
    }

    const preview = typeof parsed.body === 'string' ? parsed.body.slice(0, 500) : '';
    console.error('❌ Pipedream returned non-JSON:', preview);
    return res.status(502).json({
      ok: false,
      code: 'PIPEDREAM_NON_JSON',
      message: 'Pipedream returned non-JSON (HTML or text).',
      detail: { preview },
      _meta: { source: 'pipedream', status: parsed.status },
    });
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    console.error('🔥 /generate-proxy error:', err?.stack || err?.message || err);
    return res.status(isAbort ? 504 : 500).json({
      ok: false,
      code: isAbort ? 'PIPEDREAM_TIMEOUT' : 'PROXY_EXCEPTION',
      message: isAbort ? 'Pipedream request timed out.' : 'Unexpected proxy error.',
      detail: isAbort ? { timeoutMs: FETCH_TIMEOUT_MS } : { error: String(err) },
    });
  }
});

// ✅ Direct call with image array (kept intact)
app.post('/generate', async (req, res) => {
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
