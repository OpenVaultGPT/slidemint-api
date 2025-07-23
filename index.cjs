const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

app.post('/generate', (req, res) => {
  const { title, desc } = req.body;
  res.json({
    success: true,
    message: `Received: ${title} - ${desc}`
  });
});

app.listen(port, () => {
  console.log(`Promo Genie API running on port ${port}`);
});

