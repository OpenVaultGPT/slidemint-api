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

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// ---- Config ----
const PUBLIC_BASE_URL  = (process.env.PUBLIC_BASE_URL || 'https://slidemint-api.onrender.com').replace(/\/$/, '');
const PIPEDREAM_URL    = process.env.PIPEDREAM_URL || 'https://eos21xm8bj17yt2.m.pipedream.net';
const FETCH_TIMEOUT_MS = Number(process.env.PD_TIMEOUT_MS || 180000);

// Slideshow constants (no Ken Burns)
const OUTPUT_WIDTH = 720;
const OUTPUT_HEIGHT = 1280;
const FPS = 24;
const DEFAULT_DURATION = 2; // sec per slide
const MIN_DURATION = 0.5;

// ---- Healthcheck ----
app.get('/health', (_, res) => res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() }));

// ============================================================================
// Helpers
// ============================================================================

// Hi-res upgrader (kept for generic use)
function toHiResEbay(url) {
  try {
    const u = new URL(url);
    u.pathname = u.pathname
      .replace(/\/s-l\d+\./i, '/s-l1600.')
      .replace(/(w|h)\d+\./gi, 'w1600.');
    return u.toString();
  } catch { return url; }
}

async function fetchBufferWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    return await r.buffer();
  } finally { clearTimeout(t); }
}

// Prepare one PNG slide: blurred background (cover) + sharp foreground (contain, no upscaling)
async function prepareSlidePng(url, outPath) {
  const hi = toHiResEbay(url);
  const srcBuf = await fetchBufferWithTimeout(hi);

  const bg = await sharp(srcBuf)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'cover', position: 'centre' })
    .blur(20)
    .modulate({ brightness: 0.86, saturation: 1 })
    .toBuffer();

  const fgBuf = await sharp(srcBuf)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  const fgMeta = await sharp(fgBuf).metadata();
  const left = Math.round((OUTPUT_WIDTH  - (fgMeta.width  || 0)) / 2);
  const top  = Math.round((OUTPUT_HEIGHT - (fgMeta.height || 0)) / 2);

  const final = await sharp(bg).composite([{ input: fgBuf, top, left }]).png().toBuffer();
  fs.writeFileSync(outPath, final);
}

function writeConcatList(slideFiles, durations, listPath) {
  const lines = ['ffconcat version 1.0'];
  slideFiles.forEach((f, i) => { lines.push(`file '${f}'`); lines.push(`duration ${durations[i].toFixed(6)}`); });
  // Last file repeated per ffconcat spec
  lines.push(`file '${slideFiles[slideFiles.length - 1]}'`);
  fs.writeFileSync(listPath, lines.join('\n'));
}

async function createSlideshow(images, outputPath, duration = DEFAULT_DURATION) {
  if (!Array.isArray(images) || images.length === 0) throw new Error('No images provided');

  const tmpDir = path.join(os.tmpdir(), 'slidemint-stills', uuidv4());
  fs.mkdirSync(tmpDir, { recursive: true });

  const slideFiles = [];
  try {
    for (let i = 0; i < images.length; i++) {
      const slidePath = path.join(tmpDir, `slide-${String(i).padStart(3, '0')}.png`);
      try { await prepareSlidePng(images[i], slidePath); slideFiles.push(slidePath); }
      catch (e) { console.error('⚠️ slide prep failed, skipping:', images[i], e.message); }
    }
    if (slideFiles.length === 0) throw new Error('All images failed to load');

    const per = Math.max(MIN_DURATION, Number(duration) || DEFAULT_DURATION);
    const durations = slideFiles.map(() => per);

    const listPath = path.join(tmpDir, 'list.ffconcat');
    writeConcatList(slideFiles, durations, listPath);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-safe', '0', '-f', 'concat'])
        .videoFilters([`fps=${FPS}`, `setsar=1`])
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

// ----------------------------------------------
// STRICT eBay image normaliser (gallery-only, hi-res, dedup, cap 12)
// ----------------------------------------------
function normalizeEbayUrl(u) {
  try {
    const url = new URL(u);

    // Require eBay CDN
    if (!/\.ebayimg\.com$/i.test(url.hostname)) return null;

    // Require gallery-style path
    if (!/\/images\//i.test(url.pathname)) return null;

    // Force high-res variant
    url.pathname = url.pathname
      .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.$1')
      .replace(/\/w\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.$1')
      .replace(/\/h\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.$1');

    // Strip query cruft (?set_id=… etc.)
    url.search = '';

    return url.toString();
  } catch {
    return null;
  }
}

function cleanEbayImages(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(arr) ? arr : []) {
    if (typeof raw !== 'string') continue;
    const n = normalizeEbayUrl(raw);
    if (!n) continue;
    const key = new URL(n).pathname.toLowerCase(); // dedupe by path
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= 12) break; // hard cap
  }
  return out;
}

// ============================================================================
// Optional Pipedream proxy (unchanged flow-wise)
// ============================================================================
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}
async function parsePipedreamResponse(res) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) { try { return { kind: 'json', status: res.status, body: await res.json() }; } catch {} }
  const text = await res.text();
  try { return { kind: 'json', status: res.status, body: JSON.parse(text) }; }
  catch { return { kind: 'text', status: res.status, body: text }; }
}

app.post('/generate-proxy', async (req, res) => {
  try {
    const { itemId, images, duration } = req.body || {};
    const cleanId = itemId?.match(/\d{9,12}/)?.[0];
    if (!cleanId && !(Array.isArray(images) && images.length)) {
      return res.status(400).json({ ok:false, code:'BAD_REQUEST', message:'Provide a valid eBay itemId or images[].', detail:{ received:Object.keys(req.body||{}) }});
    }
    const pdRes = await fetchWithTimeout(PIPEDREAM_URL, {
      method:'POST',
      headers:{ 'Content-Type':'application/json','Accept':'application/json','User-Agent':'SlideMint-API/1.0' },
      body: JSON.stringify(cleanId ? { items:[cleanId], duration } : { images, duration }),
    }, FETCH_TIMEOUT_MS);

    const parsed = await parsePipedreamResponse(pdRes);
    if (parsed.kind === 'json' && pdRes.ok) {
      const videoUrl = parsed.body.videoUrl || parsed.body.placeholderVideoUrl || null;
      const cleanedUrls = Array.isArray(parsed.body.cleanedUrls) ? parsed.body.cleanedUrls : [];
      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        return res.status(502).json({ ok:false, code:'NO_VIDEO_URL', message:'Missing or invalid videoUrl from Pipedream.', detail:{ parsed: parsed.body }, _meta:{ source:'pipedream', status: parsed.status }});
      }
      return res.status(200).json({ ok: parsed.body.ok !== false, videoUrl, cleanedUrls, _meta:{ source:'pipedream', status: parsed.status }});
    }
    if (parsed.kind === 'json' && !pdRes.ok) {
      return res.status(502).json({ ok:false, code: parsed.body.code || 'PIPEDREAM_ERROR', message: parsed.body.message || 'Pipedream responded with an error.', detail: parsed.body, _meta:{ source:'pipedream', status: parsed.status }});
    }
    const preview = typeof parsed.body === 'string' ? parsed.body.slice(0,500) : '';
    console.error('❌ Pipedream returned non-JSON:', preview);
    return res.status(502).json({ ok:false, code:'PIPEDREAM_NON_JSON', message:'Pipedream returned non-JSON (HTML or text).', detail:{ preview }, _meta:{ source:'pipedream', status: parsed.status }});
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    console.error('🔥 /generate-proxy error:', err?.stack || err?.message || err);
    return res.status(isAbort ? 504 : 500).json({ ok:false, code: isAbort ? 'PIPEDREAM_TIMEOUT' : 'PROXY_EXCEPTION', message: isAbort ? 'Pipedream request timed out.' : 'Unexpected proxy error.', detail: isAbort ? { timeoutMs: FETCH_TIMEOUT_MS } : { error: String(err) }});
  }
});

// ---- Direct synchronous render (still available) ----
app.post('/generate', async (req, res) => {
  const { imageUrls, duration } = req.body;
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return res.status(400).json({ error:'Missing or invalid image URLs' });

  try {
    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoFilename = `video-${uuidv4()}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await createSlideshow(imageUrls, outputPath, duration || DEFAULT_DURATION);
    return res.status(200).json({ videoUrl: `${PUBLIC_BASE_URL}/videos/${videoFilename}` });
  } catch (err) {
    console.error('❌ Error generating video:', err.stack || err.message);
    return res.status(500).json({ error:'Video generation failed' });
  }
});

// ============================================================================
// Async jobs API
// ============================================================================
const jobs = new Map(); // jobId -> { status:'queued'|'running'|'done'|'error', url?, error? }

async function runJob(jobId, images, duration) {
  try {
    jobs.set(jobId, { status: 'running' });
    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoFilename = `video-${jobId}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await createSlideshow(images, outputPath, duration || DEFAULT_DURATION);
    jobs.set(jobId, { status: 'done', url: `${PUBLIC_BASE_URL}/videos/${videoFilename}` });
  } catch (e) {
    jobs.set(jobId, { status: 'error', error: String(e?.message || e) });
  }
}

// Enqueue (strict: max 12 s-l1600 eBay gallery images)
app.post('/jobs', (req, res) => {
  const { imageUrls, duration } = req.body || {};
  const cleaned = cleanEbayImages(imageUrls);

  if (!cleaned.length) {
    return res.status(400).json({
      ok: false,
      message: 'imageUrls[] required (eBay gallery images only)',
      detail: { hint: 'Provide https://i.ebayimg.com/.../s-l*.jpg under /images/ paths.' }
    });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'queued' });
  // fire-and-forget
  runJob(jobId, cleaned, duration);
  return res.status(202).json({ ok: true, jobId, count: cleaned.length });
});

// Poll status (resilient to restarts / multi-instance)
app.get('/jobs/:id', (req, res) => {
  const id = req.params.id;
  const j = jobs.get(id);

  if (j) {
    return res.status(200).json({ ok: true, ...j });
  }

  // Fallback: if RAM state is gone, check if file exists
  const outputDir = path.join(__dirname, 'public', 'videos');
  const videoFilename = `video-${id}.mp4`;
  const videoPath = path.join(outputDir, videoFilename);

  try {
    if (fs.existsSync(videoPath)) {
      return res.status(200).json({
        ok: true,
        status: 'done',
        url: `${PUBLIC_BASE_URL}/videos/${videoFilename}`
      });
    }
  } catch {}

  // Not found yet → treat as queued (don't 404)
  return res.status(200).json({ ok: true, status: 'queued' });
});

// ---- Launch ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SlideMint backend running on port ${PORT}`));
