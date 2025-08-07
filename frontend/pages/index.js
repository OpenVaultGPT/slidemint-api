import { useState } from 'react';

export default function Home() {
  const [itemId, setItemId] = useState('');
  const [videoUrl, setVideoUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setVideoUrl(null);

    const res = await fetch('https://eos21xm8bj17yt2.m.pipedream.net', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [itemId] })
    });

    const data = await res.json();
    setVideoUrl(data.videoUrl);
    setLoading(false);
  };

  return (
    <main style={{ padding: 40, fontFamily: 'sans-serif' }}>
      <h1>🎞️ SlideMint</h1>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={itemId}
          onChange={(e) => setItemId(e.target.value)}
          placeholder="Paste eBay Item ID or URL"
          style={{ padding: 10, width: '100%', maxWidth: 400 }}
        />
        <button type="submit" style={{ marginTop: 20, padding: 10 }}>
          Generate Video
        </button>
      </form>

      {loading && <p>⏳ Generating slideshow...</p>}

      {videoUrl && (
        <div style={{ marginTop: 30 }}>
          <video src={videoUrl} controls width="360" />
          <p>
            <a href={videoUrl} target="_blank">Download video</a>
          </p>
        </div>
      )}
    </main>
  );
}
