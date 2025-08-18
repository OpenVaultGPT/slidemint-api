// index.mjs
import express from 'express';
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

// -------------------- App & Config --------------------
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || 'https://slidemint-api.onrender.com';

const PIPEDREAM_URL =
  process.env.PIPEDREAM_URL || 'https://eos21xm8bj17yt2.m.pipedream.net';

const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 180000);

// Slideshow constants (no Ken Burns)
const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;
const FPS = 24;                 // smooth + light
const DEFAULT_DURATION = 2;     // seconds per slide
const MIN_DURATION = 0.5;       // guardrail

// -------------------- Healthcheck --------------------
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// -------------------- Helpers --------------------
function toHiResEbay(url) {
  try {
    const u = new URL(url);
    // Upgrade common eBay thumbnail patterns to the largest standard image
    u.pathname = u.pathname
      .replace(/\/s-l\d+\./i, '/s-l1600.')
      .replace(/(w|h)\d+\./gi, 'w1600.');
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchBufferWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    return await r.buffer();
  } finally {
    clearTimeout(t);
  }
}

// Prepare one PNG slide: blurred BG (cover) + sharp FG (contain, no upscaling)
async function prepareSlidePng(url, outPath) {
  const hi = toHiResEbay(url);
  const srcBuf = await fetchBufferWithTimeout(hi);

  // Background: cover-fit, strong blur, slight darken for contrast
  const bg = await sharp(srcBuf)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'cover', position: 'centre' })
    .blur(20)
    .modulate({ brightness: 0.86, saturation: 1 })
    .toBuffer();

  // Foreground: contain-fit, never upscale
  const fgBuf = await sharp(srcBuf)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  const fgMeta = await sharp(fgBuf).metadata();
  const left = Math.round((OUTPUT_WIDTH  - (fgMeta.width  || 0)) / 2);
  const top  = Math.round((OUTPUT_HEIGHT - (fgMeta.height || 0)) / 2);

  const final = await sharp(bg)
    .composite([{ input: fgBuf, top, left }])
    .png()
    .toBuffer();

  fs.writeFileSync(outPath, final);
}

// Build an FFconcat list file with per-slide durations
function writeConcatList(slideFiles, durations, listPath) {
  const lines = ['ffconcat version 1.0'];
  slideFiles.forEach((f, i) => {
    lines.push(`file '${f}'`);
    lines.push(`duration ${durations[i].toFixed(6)}`);
  });
  // Repeat last file to finalize stream (ffconcat spec)
  lines.push(`file '${slideFiles[slideFiles.length - 1]}'`);
  fs.writeFileSync(listPath, lines.join('\n'));
}

// -------------------- Slideshow (stills + concat) --------------------
async function createSlideshow(images, outputPath, duration = DEFAULT_DURATION) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('No images provided');
  }

  const tmpDir = path.join(os.tmpdir(), 'slidemint-stills', uuidv4());
  fs.mkdirSync(tmpDir, { recursive: true });

  const slideFiles = [];
  try {
    // 1) Prepare still PNGs
    for (let i = 0; i < images.length; i++) {
      const src = images[i];
      const slidePath = path.join(tmpDir, `slide-${String(i).padStart(3, '0')}.png`);
      try {
        await prepareSlidePng(src, slidePath);
        slideFiles.push(slidePath);
      } catch (e) {
        console.error('⚠️ slide prep failed, skipping:', src, e.message);
      }
    }

    if (slideFiles.length === 0) throw new Error('All images failed to load');

    // 2) Per-slide durations
    const per = Math.max(MIN_DURATION, Number(duration) || DEFAULT_DURATION);
    const durations = slideFiles.map(() => per);

    // 3) Concat list
    const listPath = path.join(tmpDir, 'list.ffconcat');
    writeConcatList(slideFiles, durations, listPath);

    // 4) Encode (fast, eBay-safe)
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-safe', '0', '-f', 'concat'])
        .videoFilters([
          `fps=${FPS}`,
          `setsar=1`
        ])
        .outputOptions([
          '-r', String(FPS),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'medium',
          '-crf', '21',
          '-maxrate', '5M',
          '-bufsize', '10M',
          '-movflags', '+faststart'
        ])
        .size(`${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`)
        .on('start', c => console.log('🎬 FFmpeg:', c))
        .on('stderr', l => console.log('📦', l))
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// -------------------- Proxy helpers --------------------
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

// -------------------- Routes --------------------
// Frontend → Pipedream → (back) → here
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

// Direct image array → video
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

// -------------------- Launch --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 SlideMint backend running on port ${PORT}`);
});
