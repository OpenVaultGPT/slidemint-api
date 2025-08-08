import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

    const pipedreamEndpoint = 'https://eos21xm8bj17yt2.m.pipedream.net';
    const response = await fetch(pipedreamEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [itemId] }),
    });

    if (!response.ok) {
      throw new Error(`Pipedream responded with ${response.status}`);
    }

    const data = await response.json();
    return res.json(data);

  } catch (err) {
    console.error('🔴 generate-proxy error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
