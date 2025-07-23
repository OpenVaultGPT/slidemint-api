import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import { exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(express.json());

app.post('/generate', async (req, res) => {
  const { imageUrls, duration } = req.body;

  try {
    if (!imageUrls || !Array.isArray(imageUrls)) {
      throw new Error('Missing or invalid imageUrls array');
    }

    const folder = `./tmp/${uuidv4()}`;
    fs.mkdirSync(folder, { recursive: true });

    // Step 1: Download images
    const downloadedImages = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch image: ${url}`);
      const buffer = await response.buffer();
      const imagePath = `${folder}/image${i.toString().padStart(3, '0')}.jpg`;
      fs.writeFileSync(imagePath, buffer);
      downloadedImages.push(imagePath);
    }
    console.log('✅ Images downloaded');

    // Step 2: Create input.txt
    const inputList = downloadedImages.map(
      (img) => `file '${img}'\nduration ${duration || 2}`
    );
    const lastFrame = `file '${downloadedImages[downloadedImages.length - 1]}'`; // no duration
    fs.writeFileSync(`${folder}/input.txt`, [...inputList, lastFrame].join('\n'));
    console.log('✅ input.txt created');

    // Step 3: Run ffmpeg
    const outputPath = `${folder}/output.mp4`;
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -f concat -safe 0 -i ${folder}/input.txt -vsync vfr -pix_fmt yuv420p ${outputPath}`,
        (err, stdout, stderr) => {
          if (err) {
            console.error('❌ ffmpeg error:', stderr);
            return reject(err);
          }
          console.log('✅ ffmpeg completed');
          resolve();
        }
      );
    });

    // Step 4: Read and send video
    if (!fs.existsSync(outputPath)) throw new Error('Output video not found!');
    const videoBuffer = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.send(videoBuffer);
    console.log('✅ Response sent');

    // Optional: Clean up temp folder
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (err) {
    console.error('💥 Error caught in handler:', err);
    res.status(500).send({ error: err.message || 'Unknown error' });
  }
});

app.listen(10000, () => {
  console.log('Promo Genie API running on port 10000');
});
