import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Serve static files from /public so MP4s are directly accessible
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());

// 🔧 Safe fetch + resize
async function fetchImageAsCanvasImage(url) {
  try {
    const response = await fetch(url, { timeout: 8000 });
    if (!response.ok) throw new Error(`Image fetch failed: ${url}`);
    const buffer = await response.buffer();

    const resized = await sharp(buffer)
      .resize({ width: 720 })
      .png()
      .toBuffer();

    return await loadImage(resized);
  } catch (err) {
    console.error(`❌ Failed image: ${url} – ${err.message}`);
    return null;
  }
}

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

    const framePath = path.join(tempFramesDir, `frame-${String(i).padStart(3, '0')}.png`);
    fs.writeFileSync(framePath, canvas.toBuffer('image/png'));
  }

  return new Promise((resolve, reject) => {
  const inputs = path.join(tempFramesDir, 'frame-%03d.png');

  const command = ffmpeg()
  .input(inputs)
  .inputOptions([
    '-stream_loop', '1', // ✅ Loop the input 1 extra time = play twice
    '-framerate', (1 / duration).toFixed(2)
  ])
    .outputOptions([
      '-vf', 'scale=720:-2',
      '-r', '30',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart'
    ])
    .videoCodec('libx264')
    .save(outputPath)
    .on('start', (cmd) => console.log('🎬 FFmpeg started:', cmd))
    .on('stderr', (line) => console.log('📦 FFmpeg:', line))
    .on('end', () => {
      console.log('✅ FFmpeg finished');
      fs.rmSync(tempFramesDir, { recursive: true, force: true });
      resolve();
    })
    .on('error', (err) => {
      console.error('❌ FFmpeg error:', err.message);
      reject(err);
    });

});

}

app.post('/generate', async (req, res) => {
  const { imageUrls, duration = 2 } = req.body;

  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'No image URLs provided' });
  }

  const safeImageUrls = imageUrls.slice(0, 12); // ✅ Up to 12 images
  const videoId = uuidv4();
  const outputPath = path.join(__dirname, 'public', 'videos', `${videoId}.mp4`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  try {
    console.log(`🎬 Generating video: ${videoId}`);
    console.log('🧠 Memory usage at start:', process.memoryUsage());
    console.time('🕒 Slideshow duration');

    await createSlideshow(safeImageUrls, outputPath, duration);

    console.timeEnd('🕒 Slideshow duration');
    console.log('🧠 Memory usage at end:', process.memoryUsage());

    const baseUrl = 'https://promo-genie-api.onrender.com'; // ← or use env var for flexibility
res.status(200).json({
  success: true,
  videoUrl: `${baseUrl}/videos/${videoId}.mp4`,
  placeholderVideoUrl: `${baseUrl}/videos/${videoId}.mp4`,
  imageUrls: safeImageUrls
});

  } catch (err) {
    console.error('❌ Slideshow generation failed:', err.message);
    res.status(500).json({ error: 'Video generation failed' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PromoGenie backend running on port ${PORT}`);
});
