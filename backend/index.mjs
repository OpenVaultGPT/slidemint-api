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

// ✅ Healthcheck
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// 📥 Safe image fetch + resize (bigger headroom for Ken Burns)
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();

    // Headroom for zoom/pan; do not upscale beyond source
    const resized = await sharp(buffer)
      .resize({ width: 1440, withoutEnlargement: true })
      .png()
      .toBuffer();

    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed to process image: ${url}`, err.message);
    return null;
  }
}

// 🎞️ Build slideshow (Ken Burns + autoplay 2x)
async function createSlideshow(images, outputPath, duration = 2) {
  const width = 720;   // portrait output to suit eBay phone view
  const height = 1280;
  const fps = 30;
  const framesPerSlide = Math.max(1, Math.round((duration || 2) * fps));
  const repeatCount = 2; // play whole sequence twice

  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  // Preload images
  const loaded = await Promise.all(images.map(u => fetchImageAsCanvasImage(u)));

  // simple smooth easing
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Draw one frame with gentle pan/zoom
  function drawKenBurnsFrame(ctx, img, slideIdx, frameIdx, totalFrames) {
    // background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (!img) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ Image failed to load', width / 2, height / 2);
      return;
    }

    const t = easeInOut(totalFrames > 1 ? frameIdx / (totalFrames - 1) : 0);

    // cover-scale to fill canvas; then add gentle zoom
    const cover = Math.max(width / img.width, height / img.height);
    const startZ = 1.05; // subtle
    const endZ = 1.12;
    const zoom = cover * (slideIdx % 2 === 0
      ? startZ + (endZ - startZ) * t
      : endZ + (startZ - endZ) * t);

    const dw = img.width * zoom;
    const dh = img.height * zoom;

    // pan patterns: L→R, T→B, R→L, B→T
    let x, y;
    switch (slideIdx % 4) {
      case 0: // left → right
        x = (width - dw) * t;
        y = (height - dh) / 2;
        break;
      case 1: // top → bottom
        x = (width - dw) / 2;
        y = (height - dh) * t;
        break;
      case 2: // right → left
        x = (width - dw) * (1 - t);
        y = (height - dh) / 2;
        break;
      default: // bottom → top
        x = (width - dw) / 2;
        y = (height - dh) * (1 - t);
        break;
    }

    // draw
    ctx.drawImage(
      img,
      Math.round(x),
      Math.round(y),
      Math.round(dw),
      Math.round(dh)
    );
  }

  // Render frames (loop sequence twice)
  let globalFrame = 0;
  try {
    for (let loop = 0; loop < repeatCount; loop++) {
      for (let i = 0; i < loaded.length; i++) {
        const img = loaded[i];
        for (let f = 0; f < framesPerSlide; f++) {
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext('2d');
          drawKenBurnsFrame(ctx, img, i, f, framesPerSlide);

          const framePath = path.join(
            tempFramesDir,
            `frame-${String(globalFrame).padStart(5, '0')}.png`
          );
          fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
          globalFrame++;
        }
      }
    }

    // Stitch frames → MP4 (safe, eBay-friendly, no exotic filters)
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tempFramesDir, 'frame-%05d.png'))
        .inputOptions(['-framerate', String(fps)])
        .outputOptions([
          // keep it simple: frames are already 720x1280
          '-r', String(fps),

          // standard H.264; preset bumped for quality vs ultrafast
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'medium',
          '-b:v', '5M',

          // (optional but safe) small extra hints — uncomment if you want after first test:
          // '-profile:v', 'high',
          // '-level', '4.0',
          // '-g', '60',
          // '-bf', '3',

          '-movflags', '+faststart'
        ])
        .save(outputPath)
        .on('start', cmd => console.log('🎬 FFmpeg started:', cmd))
        .on('stderr', line => console.log('📦 FFmpeg:', line))
        .on('end', () => {
          console.log('✅ FFmpeg finished');
          resolve();
        })
        .on('error', err => {
          console.error('❌ FFmpeg error:', err.message);
          reject(err);
        });
    });
  } finally {
    // clean up temp frames
    try { fs.rmSync(tempFramesDir, { recursive: true, force: true }); } catch {}
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
    } catch { /* fall through */ }
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
