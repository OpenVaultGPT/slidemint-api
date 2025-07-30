import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load and convert remote image to canvas-friendly PNG
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${url}`);
    const buffer = await response.buffer();
    const convertedBuffer = await sharp(buffer).png().toBuffer();
    return await loadImage(convertedBuffer);
  } catch (err) {
    console.error(`❌ Image failed: ${url} – ${err.message}`);
    return null;
  }
}

// Create slideshow video from array of image URLs
async function createSlideshow(images, outputPath, duration = 2) {
  const width = 720;
  const height = 1280;
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  for (let i = 0; i < images.length; i++) {
    console.log(`🖼️ Rendering image ${i + 1} of ${images.length}`);
    const img = await fetchImageAsCanvasImage(images[i]);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Fill background
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

    const outPath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  }

  return new Promise((resolve, reject) => {
    const inputs = path.join(tempFramesDir, 'frame-%03d.png');
    ffmpeg()
      .input(inputs)
      .inputFPS(1 / duration) // Seconds per frame
      .outputFPS(30)          // Smooth playback
      .videoCodec('libx264')
      .outputOptions('-pix_fmt yuv420p')
      .save(outputPath)
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

// Endpoint: POST /generate
app.post('/generate', async (req, res) => {
  const { imageUrls, duration = 2 } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'No image URLs provided' });
  }

  const safeImageUrls = imageUrls.slice(0, 15); // Limit to 15 images
  const videoId = uuidv4();
  const outputPath = path.join(__dirname, 'videos', `${videoId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    await createSlideshow(safeImageUrls, outputPath, duration);
    res.status(200).json({ videoUrl: `/videos/${videoId}.mp4` });
  } catch (err) {
    res.status(500).json({ error: 'Video generation failed' });
  }
});

// Serve videos statically
app.use('/videos', express.static(path.join(__dirname, 'videos')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PromoGenie backend running on port ${PORT}`);
});
