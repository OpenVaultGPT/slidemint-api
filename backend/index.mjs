// index.mjs
import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- Config --------------------
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Public base (for returned video URLs)
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://slidemint-api.onrender.com';

// Pipedream proxy
const PIPEDREAM_URL =
  process.env.PIPEDREAM_URL || 'https://eos21xm8bj17yt2.m.pipedream.net';

// Proxy timeout (default 3 min to avoid premature aborts)
const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 180000);

// Slideshow/render constants tuned for speed + quality
const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;
const FPS = 24;                 // smooth, fewer frames than 30
const DEFAULT_DURATION = 2;     // seconds per slide (before capping)
const MAX_FRAMES_PER_SLIDE = 45;// hard cap (~2s @ 24fps)
const SRC_MAX_WIDTH = 1280;     // resize sources to reduce IO (still sharp for 720p)

// -------------------- Healthcheck --------------------
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// -------------------- Image fetch + resize --------------------
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();

    // Resize down to reduce IO; do not upscale beyond source
    const resized = await sharp(buffer)
      .resize({ width: SRC_MAX_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();

    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed to process image: ${url}`, err.message);
    return null;
  }
}

// -------------------- Slideshow (Ken Burns, single pass) --------------------
async function createSlideshow(images, outputPath, duration = DEFAULT_DURATION) {
  const framesPerSlide = Math.min(
    MAX_FRAMES_PER_SLIDE,
    Math.max(1, Math.round((duration || DEFAULT_DURATION) * FPS))
  );

  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('No images provided');
  }

  // Use OS temp dir for faster disk and auto-clean by platform
  const tempFramesDir = path.join(os.tmpdir(), 'slidemint-frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  // Preload images
  const loaded = await Promise.all(images.map(u => fetchImageAsCanvasImage(u)));

  // Easing for gentle motion
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function drawKenBurnsFrame(ctx, img, slideIdx, frameIdx, totalFrames) {
    // background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

    if (!img) {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚠️ Image failed to load', OUTPUT_WIDTH / 2, OUTPUT_HEIGHT / 2);
      return;
    }

    const t = totalFrames > 1 ? easeInOut(frameIdx / (totalFrames - 1)) : 0;

    // Cover-scale to fill canvas; subtle zoom to keep encode friendly
    const cover = Math.max(OUTPUT_WIDTH / img.width, OUTPUT_HEIGHT / img.height);
    const startZ = 1.03;
    const endZ = 1.08;
    const zoom = cover * (slideIdx % 2 === 0
      ? startZ + (endZ - startZ) * t
      : endZ + (startZ - endZ) * t);

    const dw = img.width * zoom;
    const dh = img.height * zoom;

    // pan patterns: L→R, T→B, R→L, B→T
    let x, y;
    switch (slideIdx % 4) {
      case 0: // left → right
        x = (OUTPUT_WIDTH - dw) * t;
        y = (OUTPUT_HEIGHT - dh) / 2;
        break;
      case 1: // top → bottom
        x = (OUTPUT_WIDTH - dw) / 2;
        y = (OUTPUT_HEIGHT - dh) * t;
        break;
      case 2: // right → left
        x = (OUTPUT_WIDTH - dw) * (1 - t);
        y = (OUTPUT_HEIGHT - dh) / 2;
        break;
      default: // bottom → top
        x = (OUTPUT_WIDTH - dw) / 2;
        y = (OUTPUT_HEIGHT - dh) * (1 - t);
        break;
    }

    ctx.drawImage(
      img,
      Math.round(x),
      Math.round(y),
      Math.round(dw),
      Math.round(dh)
    );
  }

  // Render frames (single pass — no x2 loop)
  let globalFrame = 0;
  try {
    for (let i = 0; i < loaded.length; i++) {
      const img = loaded[i];
      for (let f = 0; f < framesPerSlide; f++) {
        const canvas = createCanvas(OUTPUT_WIDTH, OUTPUT_HEIGHT);
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

    // Stitch frames → MP4 (eBay-friendly)
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(tempFramesDir, 'frame-%05d.png'))
        .inputOptions(['-framerate', String(FPS)])
        .outputOptions([
          '-r', String(FPS),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'medium',
          // CRF + cap plays nice with marketplace transcoders
          '-crf', '21',
          '-maxrate', '5M',
          '-bufsize', '10M',
          '-movflags', '+faststart'
        ])
        .size(`${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`)
        .save(outputPath)
        .on('start', cmd => console.log('🎬 FFmpeg started:', cmd))
        .on('stderr', line => console.log('📦 FFmpeg:', line))
        .on('end', () => { console.log('✅ FFmpeg finished'); resolve(); })
        .on('error', err => { console.error('❌ FFmpeg error:', err.message); reject(err); });
    });
  } finally {
    // Best-effort cleanup
    try { fs.rmSync(tempFramesDir, { recursive: true, force: true }); } catch {}
  }
}

// -------------------- Helpers for Pipedream proxy --------------------
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

// -------------------- Proxy route (frontend → Pipedream) --------------------
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

// -------------------- Direct image array → video --------------------
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

    await createSlideshow(imageUrls, outputPath, duration || DEFAULT_DURATION);

    const videoUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/videos/${videoFilename}`;
    return res.status(200).json({ videoUrl });
  } catch (err) {
    console.error('❌ Error generating video:', err.stack || err.message);
    return res.status(500).json({ error: 'Video generation failed' });
  }
});

// -------------------- Launch server --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SlideMint backend running on port ${PORT}`);
});
