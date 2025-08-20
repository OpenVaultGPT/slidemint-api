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
const JOB_LIMIT_MS     = Number(process.env.JOB_LIMIT_MS || 4 * 60 * 1000); // 4 min

// ---- Slideshow constants (LANDSCAPE 16:9 for eBay player) ----
const OUTPUT_WIDTH  = 1920;     // fill eBay player (no bars)
const OUTPUT_HEIGHT = 1080;
const FPS = 30;                 // eBay-friendly
const DEFAULT_DURATION = 1.0;   // ~1s per image
const MIN_DURATION = 0.5;

// Optional default loop count (can be overridden per request)
const DEFAULT_LOOP_COUNT = Number(process.env.DEFAULT_LOOP_COUNT || 1); // default = 1 to keep encodes fast

// ---- Healthcheck ----
app.get('/health', (_, res) =>
  res.status(200).json({ ok: true, service: 'slidemint-api', ts: new Date().toISOString() })
);

// ============================================================================
// Helpers
// ============================================================================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchBufferWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*' }, signal: controller.signal });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${url}`);
    return await r.buffer();
  } finally { clearTimeout(t); }
}

// Build $_57 original variant
function toOriginal57(u) {
  try {
    const url = new URL(u);
    url.search = '';
    url.pathname = url.pathname
      .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/$_57.jpg')
      .replace(/\/w\d+\.(jpg|jpeg|png|webp)$/i,  '/$_57.jpg')
      .replace(/\/h\d+\.(jpg|jpeg|png|webp)$/i,  '/$_57.jpg');
    return url.toString();
  } catch { return u; }
}

// Force eBay path to a given size and strip query
function forceVariant(u, size = 1600) {
  try {
    const url = new URL(u);
    url.search = '';
    url.pathname = url.pathname
      .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, `/s-l${size}.jpg`)
      .replace(/\/w\d+\.(jpg|jpeg|png|webp)$/i,  `/s-l${size}.jpg`)
      .replace(/\/h\d+\.(jpg|jpeg|png|webp)$/i,  `/s-l${size}.jpg`)
      .replace(/\/\$_\d+\.(jpg|jpeg|png|webp)$/i, `/s-l${size}.jpg`);
    return url.toString();
  } catch { return u; }
}

function buildCandidates(u) {
  try {
    const p = new URL(u).pathname;
    const isLegacy = /\/\d{2}\/s\//i.test(p); // /00/s/...
    const sizes = isLegacy ? [1200, 1000, 800, 640, 500] : [1600, 1200, 1000, 800, 500];
    const ladder = sizes.map(s => forceVariant(u, s));
    const orig57 = toOriginal57(u);
    const origRaw = new URL(u).toString();
    return [...ladder, orig57, origRaw];
  } catch {
    return [u];
  }
}

// Download and validate the first real image (not a placeholder)
async function resolveImageBuffer(u) {
  const MIN_BYTES = 5000;
  const candidates = buildCandidates(u);
  for (const cand of candidates) {
    try {
      const buf = await fetchBufferWithTimeout(cand, 5000);
      if (buf.length < MIN_BYTES) continue;
      await sharp(buf).metadata();
      return { buf, url: cand };
    } catch { /* next */ }
  }
  return null;
}

// Prepare one JPEG slide: COVER fit (fills 16:9, crops edges if needed). No blur/bars.
async function prepareSlideJpg(url, outPath) {
  const resolved = await resolveImageBuffer(url);
  if (!resolved) throw new Error('No reachable/valid image');
  const srcBuf = resolved.buf;

  const final = await sharp(srcBuf)
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  fs.writeFileSync(outPath, final); // outPath ends with .jpg
}

function writeConcatList(slideFiles, durations, listPath) {
  const lines = ['ffconcat version 1.0'];
  slideFiles.forEach((f, i) => { lines.push(`file '${f}'`); lines.push(`duration ${durations[i].toFixed(6)}`); });
  // Repeat last file per ffconcat spec
  lines.push(`file '${slideFiles[slideFiles.length - 1]}'`);
  fs.writeFileSync(listPath, lines.join('\n'));
}

// Render slides → MP4 (1080p landscape, eBay-friendly encode), add silent audio
async function renderFromSlides(listPath, outputPath) {
  await new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(listPath)
      .inputOptions(['-safe', '0', '-f', 'concat'])
      .input('anullsrc=cl=stereo:r=44100') // silent track
      .inputFormat('lavfi')
      .videoFilters([`fps=${FPS}`, `setsar=1`])
      .outputOptions([
        '-r', String(FPS),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.1',
        '-tune', 'stillimage',
        '-crf', '21',
        '-maxrate', '8M',
        '-bufsize', '16M',
        '-g', '60',                 // keyframe ≈2s
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart'
      ])
      .size(`${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`)  // 1920×1080 landscape
      .on('start', c => console.log('🎬 FFmpeg:', c))
      .on('stderr', l => console.log('📦', l))
      .on('end', resolve)
      .on('error', reject);

    cmd.save(outputPath);
  });
}

// Concatenate the same MP4 N times without re-encoding (no duplicate image processing)
async function loopMp4Copy(inputMp4, outputMp4, times = 1) {
  times = Math.max(1, Math.floor(times));
  if (times === 1) {
    fs.copyFileSync(inputMp4, outputMp4);
    return;
  }
  const tmpDir = path.join(os.tmpdir(), 'slidemint-loop', uuidv4());
  fs.mkdirSync(tmpDir, { recursive: true });
  const listPath = path.join(tmpDir, 'concat.txt');

  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < times; i++) {
    lines.push(`file '${inputMp4.replace(/'/g, "'\\''")}'`);
  }
  fs.writeFileSync(listPath, lines.join('\n'));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-safe', '0', '-f', 'concat'])
      .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
      .on('end', resolve)
      .on('error', reject)
      .save(outputMp4);
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

async function createSlideshow(images, outputPath, durationSec = DEFAULT_DURATION, loopCount = DEFAULT_LOOP_COUNT) {
  if (!Array.isArray(images) || images.length === 0) throw new Error('No images provided');

  const tmpDir = path.join(os.tmpdir(), 'slidemint-stills', uuidv4());
  fs.mkdirSync(tmpDir, { recursive: true });

  const slideFiles = [];
  try {
    // 1) Build slides (JPEG, cover fit)
    for (let i = 0; i < images.length; i++) {
      const slidePath = path.join(tmpDir, `slide-${String(i).padStart(3, '0')}.jpg`);
      try { await prepareSlideJpg(images[i], slidePath); slideFiles.push(slidePath); }
      catch (e) { console.error('⚠️ slide prep failed, skipping:', images[i], e.message); }
    }
    if (slideFiles.length === 0) throw new Error('All images failed to load');

    // 2) 1s per image (or provided), hard cuts
    const per = Math.max(MIN_DURATION, Number(durationSec) || DEFAULT_DURATION);
    const durations = slideFiles.map(() => per);
    const listPath = path.join(tmpDir, 'list.ffconcat');
    writeConcatList(slideFiles, durations, listPath);

    // 3) Render a single-pass MP4 (1080p landscape)
    const baseOnce = outputPath.replace(/\.mp4$/, '-once.mp4');
    await renderFromSlides(listPath, baseOnce);

    // 4) Optional looping (no re-encode)
    const loops = Math.max(1, Number(loopCount) || 1);
    await loopMp4Copy(baseOnce, outputPath, loops);

    try { fs.unlinkSync(baseOnce); } catch {}
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---- URL cleaning (unchanged) ----
function normalizeEbayUrl(u) {
  try {
    const url = new URL(u);
    if (!/(^|\.)ebayimg\.com$/i.test(url.hostname)) return null;
    if (!(/\/images\//i.test(url.pathname) || /\/\d{2}\/s\//i.test(url.pathname))) return null;
    url.search = '';
    url.pathname = url.pathname
      .replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.jpg')
      .replace(/\/w\d+\.(jpg|jpeg|png|webp)$/i,  '/s-l1600.jpg')
      .replace(/\/h\d+\.(jpg|jpeg|png|webp)$/i,  '/s-l1600.jpg')
      .replace(/\/\$_\d+\.(jpg|jpeg|png|webp)$/i, '/s-l1600.jpg');
    return url.toString();
  } catch { return null; }
}

function cleanEbayImages(arr) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(arr) ? arr : []) {
    if (typeof raw !== 'string') continue;
    const n = normalizeEbayUrl(raw);
    if (!n) continue;
    const key = new URL(n).pathname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= 12) break;
  }
  return out;
}

// ============================================================================
// Optional Pipedream proxy (unchanged)
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

// ---- Direct synchronous render (adds loopCount)
app.post('/generate', async (req, res) => {
  const { imageUrls, duration, loopCount } = req.body;
  if (!Array.isArray(imageUrls) || imageUrls.length === 0)
    return res.status(400).json({ error:'Missing or invalid image URLs' });

  try {
    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoFilename = `video-${uuidv4()}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await createSlideshow(imageUrls, outputPath, duration ?? DEFAULT_DURATION, loopCount ?? DEFAULT_LOOP_COUNT);
    return res.status(200).json({ videoUrl: `${PUBLIC_BASE_URL}/videos/${videoFilename}` });
  } catch (err) {
    console.error('❌ Error generating video:', err.stack || err.message);
    return res.status(500).json({ error:'Video generation failed' });
  }
});

// ============================================================================
// Async jobs API (adds loopCount)
// ============================================================================
const jobs = new Map();

async function runJob(jobId, images, duration, loopCount) {
  try {
    jobs.set(jobId, { status: 'running' });

    const outputDir = path.join(__dirname, 'public', 'videos');
    fs.mkdirSync(outputDir, { recursive: true });
    const videoFilename = `video-${jobId}.mp4`;
    const outputPath = path.join(outputDir, videoFilename);

    await Promise.race([
      createSlideshow(images, outputPath, duration ?? DEFAULT_DURATION, loopCount ?? DEFAULT_LOOP_COUNT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIME_LIMIT')), JOB_LIMIT_MS))
    ]);

    jobs.set(jobId, { status: 'done', url: `${PUBLIC_BASE_URL}/videos/${videoFilename}` });
  } catch (e) {
    jobs.set(jobId, { status: 'error', error: String(e?.message || e) });
  }
}

app.post('/jobs', (req, res) => {
  const { imageUrls, duration, loopCount } = req.body || {};
  const cleaned = cleanEbayImages(imageUrls);

  if (!cleaned.length) {
    return res.status(400).json({
      ok: false,
      message: 'imageUrls[] required (eBay gallery images only)',
      detail: { hint: 'Provide https://i.ebayimg.com/... under /images/ or /00/s/ paths.' }
    });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'queued' });
  runJob(jobId, cleaned, duration, loopCount); // fire-and-forget
  return res.status(202).json({ ok: true, jobId, count: cleaned.length });
});

// Poll status
app.get('/jobs/:id', (req, res) => {
  const id = req.params.id;
  const j = jobs.get(id);
  if (j) return res.status(200).json({ ok: true, ...j });

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

  return res.status(200).json({ ok: true, status: 'queued' });
});

// ---- Launch ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SlideMint backend running on port ${PORT}`));
