import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

sharp.cache(false); // Prevent sharp memory bloat

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Safe image fetch + resize + fallback
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 10000 });

    const contentType = response.headers.get('content-type');
    if (!response.ok || !contentType || !contentType.startsWith('image')) {
      throw new Error(`Invalid response or non-image URL: ${url}`);
    }

    const buffer = await response.buffer();

    const convertedBuffer = await sharp(buffer)
      .resize({ width: 720 }) // Safe resize
      .png()
      .toBuffer();

    return await loadImage(convertedBuffer);
  } catch (err) {
    console.error(`❌ Failed image: ${url} — ${err.message}`);

    const canvas = createCanvas(720, 1280);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, 720, 1280);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚠️ Image failed to load', 360, 640);

    return await loadImage(canvas.toBuffer('image/png'));
  }
}

// 🎞️ Slideshow generator
async function createSlideshow(images, outputPath, duration = 2) {
  const width = 720;
  const height = 1280;
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  for (let i = 0; i < images.length; i++) {
    console.log(`🖼️ Rendering frame ${i + 1} of ${images.length}`);
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
    }

    const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
  }

  return new Promise((resolve, reject) => {
    const inputs = path.join(tempFramesDir, 'frame-%03d.png');
    ffmpeg()
      .input(inputs)
      .inputFPS(1 / duration)
      .outputFPS(30)
      .videoCodec('libx264')
      .outputOptions('-pix_fmt yuv420p')
      .save(outputPath)
      .on('stderr', (line) => console.log('FFmpeg:', line))
      .on('end', () => {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
        resolve();
      })
      .on('error', (err) => {
        console.error('❌ FFmpeg error:', err.message);
        reject(err);
      });
  });
}

// 🚀 POST /generate – accepts { imageUrls, duration }
app.post('/generate', async (req, res) => {
  const { imageUrls, duration = 2 } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'No image URLs provided' });
  }

  const safeImageUrls = imageUrls.slice(0, 15);
  const videoId = uuidv4();
  const outputPath = path.join(__dirname, 'videos', `${videoId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    console.log(`🎬 Generating video: ${videoId}`);
    await createSlideshow(safeImageUrls, outputPath, duration);
    res.status(200).json({ videoUrl: `/videos/${videoId}.mp4` });
  } catch (err) {
    console.error('❌ Slideshow generation failed:', err.message);
    res.status(500).json({ error: 'Video generation failed' });
  }
});

// Serve static videos
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PromoGenie backend running on port ${PORT}`);
});
