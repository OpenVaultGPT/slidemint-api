import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Required for ES module resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// App setup
const app = express();
app.use(cors());
app.use(express.json());

// POST endpoint to process slideshow
app.post('/process', async (req, res) => {
  const { imageUrls, duration, textOverlay } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'Invalid image URLs' });
  }

  try {
    const tempDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    // Download images
    const imagePaths = await Promise.all(
      imageUrls.map(async (url) => {
        const filename = `${uuidv4()}.jpeg`;
        const filepath = path.join(tempDir, filename);
        const writer = fs.createWriteStream(filepath);
        const response = await axios.get(url, { responseType: 'stream' });
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        return filepath;
      })
    );

    // Prepare ffmpeg input list
    const listPath = path.join(tempDir, 'input.txt');
    const listContent = imagePaths
      .map((p) => `file '${p.replace(/'/g, "\\'")}'\nduration ${duration}`)
      .join('\n');
    fs.writeFileSync(listPath, listContent);

    // Output video
    const outputPath = path.join(tempDir, `${uuidv4()}.mp4`);
    const textFilter = `drawtext=text='${textOverlay}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-60`;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions('-f', 'concat', '-safe', '0')
        .outputOptions('-vf', textFilter)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.download(outputPath, 'promo.mp4', (err) => {
      if (err) console.error('Download error:', err);
      imagePaths.concat(outputPath, listPath).forEach((p) => fs.unlinkSync(p));
    });
  } catch (error) {
    console.error('Processing failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
