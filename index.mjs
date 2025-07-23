import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to fetch remote image and load it as canvas image
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${url}`);
    const buffer = await response.buffer();
    return await loadImage(buffer);
  } catch (err) {
    console.error('Image load error:', err);
    return null;
  }
}

// Create a video from image URLs
async function createSlideshow(images, outputPath) {
  const width = 1280;
  const height = 720;
  const duration = 2; // seconds per image
  const tempFramesDir = path.join(__dirname, 'frames', uuidv4());
  fs.mkdirSync(tempFramesDir, { recursive: true });

  // Render frames
  for (let i = 0; i < images.length; i++) {
    const img = await fetchImageAsCanvasImage(images[i]);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (img) {
      const aspect = img.width / img.height;
      let drawWidth = width, drawHeight = width / aspect;
      if (drawHeight > height) {
        drawHeight = height;
        drawWidth = height * aspect;
      }

      const x = (width - drawWidth) / 2;
      const y = (height - drawHeight) / 2;
      ctx.drawImage(img, x, y, drawWidth, drawHeight);
    } else {
      ctx.fillStyle = '#fff';
      ctx.font = '40px sans-serif';
      ctx.fillText('Image not loaded', 50, height / 2);
    }

    const outPath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  }

  // Generate video
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(tempFramesDir, 'frame-%03d.png'))
      .inputFPS(1 / duration)
      .outputFPS(30)
      .videoCodec('libx264')
      .outputOptions('-pix_fmt yuv420p')
      .save(outputPath)
      .on('end', () => {
        fs.rmSync(tempFramesDir, { recursive: true, force: true });
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

// API endpoint
app.post('/generate', async (req, res) => {
  const { imageUrls } = req.body;
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'No image URLs provided' });
  }

  const videoId = uuidv4();
  const outputPath = path.join(__dirname, 'videos', `${videoId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    await createSlideshow(imageUrls, outputPath);
    res.status(200).json({ videoUrl: `/videos/${videoId}.mp4` });
  } catch (err) {
    console.error('Video generation error:', err);
    res.status(500).json({ error: 'Video generation failed' });
  }
});

// Serve generated videos
app.use('/videos', express.static(path.join(__dirname, 'videos')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PromoGenie API running on port ${PORT}`);
});
