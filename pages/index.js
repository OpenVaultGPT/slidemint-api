import React, { useState } from "react";

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setVideoUrl(null);

    try {
      const response = await fetch("https://eos21xm8bj17yt2.m.pipedream.net", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [input] }),
      });

      const data = await response.json();

      if (data.videoUrl) {
        setVideoUrl(data.videoUrl);
      } else {
        throw new Error("No video URL returned");
      }
    } catch (err) {
      setError("❌ Something went wrong. Please try again.");
    }

    setLoading(false);
  };

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: 40, fontFamily: "Montserrat, sans-serif" }}>
      <h1 style={{ textAlign: "center", color: "#00b894" }}>🎬 SlideMint</h1>
      <p style={{ textAlign: "center", fontSize: "1.1em", marginBottom: 30 }}>
        Enter an eBay item number or URL below to generate your slideshow video.
      </p>

      <form onSubmit={handleSubmit} style={{ textAlign: "center" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 365683839357"
          style={{
            padding: 12,
            width: "100%",
            maxWidth: 400,
            fontSize: 16,
            borderRadius: 6,
            border: "1px solid #ccc",
            marginBottom: 20,
          }}
          required
        />
        <br />
        <button
          type="submit"
          style={{
            background: "#00b894",
            color: "#fff",
            padding: "12px 24px",
            borderRadius: 6,
            border: "none",
            fontWeight: "bold",
            fontSize: 16,
            cursor: "pointer",
          }}
        >
          ▶️ Generate Video
        </button>
      </form>

      {loading && (
        <div style={{ textAlign: "center", marginTop: 30 }}>
          <p style={{ fontSize: "1.2em", fontWeight: "500", color: "#00796B" }}>🛠️ SlideMint is minting your video...</p>
          <div className="dot-flashing" />
        </div>
      )}

      {videoUrl && (
        <div style={{ textAlign: "center", marginTop: 40 }}>
          <p style={{ fontSize: "1.4em", fontWeight: "bold", color: "#009688" }}>✅ Your slideshow is ready!</p>
          <video width="320" controls style={{ marginTop: 20, borderRadius: 10 }}>
            <source src={videoUrl} type="video/mp4" />
            Your browser does not support the video tag.
          </video>
          <br />
          <a
            href={videoUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              background: "#00b894",
              color: "#fff",
              padding: "12px 24px",
              borderRadius: "6px",
              textDecoration: "none",
              fontWeight: "bold",
              fontSize: "1em",
              marginTop: 20,
            }}
          >
            ⬇️ Download Video
          </a>
        </div>
      )}

      {error && (
        <p style={{ color: "#c0392b", textAlign: "center", marginTop: 30, fontWeight: "bold" }}>{error}</p>
      )}

      <style jsx>{`
        .dot-flashing {
          position: relative;
          width: 12px;
          height: 12px;
          border-radius: 6px;
          background-color: #00b894;
          animation: dotFlashing 1s infinite linear alternate;
          margin: 0 auto;
        }

        @keyframes dotFlashing {
          0% {
            opacity: 0.2;
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0.2;
          }
        }
      `}</style>
    </div>
  );
}
