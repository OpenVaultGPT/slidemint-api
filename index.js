import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/process', async (req, res) => {
  const { imageUrls, duration, textOverlay } = req.body;

  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({ error: 'Invalid image URLs' });
  }

  return res.json({
    message: 'Image URLs accepted ✅',
    imageCount: imageUrls.length,
    duration,
    overlay: textOverlay
  });
});

app.listen(process.env.PORT || 3000, () =>
  console.log('✅ Promo Genie API running')
);
