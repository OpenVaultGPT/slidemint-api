// index.mjs — SlideMint backend (1080p HQ, PNG frames, global fetch, lazy native imports)
// Drop-in replacement. Fixes Render 502 on /health by removing node-fetch
// and lazy-loading native modules (canvas/sharp/ffmpeg) only when needed.

import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ---- config ----
const PIPEDREAM_URL = process.env.PIPEDREAM_URL || 'https://eos21xm8bj17yt2.m.pipedream.net';
const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 60000);

// ---- lazy imports for native deps (avoid boot crashes) ----
const getCanvas = async () => (await import('canvas'));
const getSharp  = async () => {
  const m = await import('sharp');
  return m.default || m;
};
const getFfmpeg = async () => {
  const m = await import('fluent-ffmpeg');
  return m.default || m;
};

// ✅ Healthcheck (should work even if native deps fail to load)
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// 📥 Safe image fetch + pre-resize (no upscaling; fast PNG to speed IO)
async function fetchImageAsCanvasImage(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(t);

    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const sharp = await getSharp();
    const resized = await sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .png({ compressionLevel: 2, adaptiveFiltering: false })
      .toBuffer();

    const { loadImage } = await getCanvas();
    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed to process image: ${url}`, err.message);
    return null;
  }
}

// 🎞️ Build slideshow (1080p, CRF 20, stillimage tune)
async function createSlideshow(images, outputPath, duration = 2) {
  const width = 1920, height = 1080;
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  const { createCanvas } = await getCanvas();

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
      if (drawHeight > height) { drawHeight = height; drawWidth = height * aspect; }
      const x = (width - drawWidth) / 2;
      const y = (height - drawHeight) / 2;
      ctx.drawImage(img, x, y, drawWidth, drawHeight);
    } else {
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⚠️ Image failed to load', width / 2, height / 2);
    }

    const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer('image/png', { compressionLevel: 2 }));
  }

  const ffmpeg = await getFfmpeg();

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(tempFramesDir, 'frame-%03d.png'))
      .inputOptions(['-framerate', (1 / duration).toFixed(2)]) // e.g. 0.50 for 2s/slide
      .outputOptions([
        '-vf', 'scale=1920:1080:flags=lanczos',
        '-r', '30',
        '-preset', 'veryfast',
        '-crf', '20',              // 18–22 typical; 20 is good for eBay
        '-tune', 'stillimage',
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

// ---- helpers for Pipedream proxy (unchanged API) ----
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
    try { const json = await res.json(); return { kind: 'json', status: res.status, body: json }; } catch {}
  }
  const text = await res.text();
  try { const json = JSON.parse(text); return { kind: 'json', status: res.status, body: json }; }
  catch { return { kind: 'text', status: res.status, body: text }; }
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

    await createSlideshow(imageUrls.slice(0, 12), outputPath, duration || 2);

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
