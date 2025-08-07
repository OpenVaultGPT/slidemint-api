document.getElementById("videoForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  const url = this.querySelector('input[name="url"]').value;
  const itemIdMatch = url.match(/\d{9,12}/);
  const itemId = itemIdMatch ? itemIdMatch[0] : null;

  if (!itemId) {
    alert("Please enter a valid eBay item URL or ID.");
    return;
  }

  // Show status spinner
  document.getElementById("status").classList.remove("hidden");
  document.getElementById("result").classList.add("hidden");
  document.getElementById("error").classList.add("hidden");

  try {
    const res = await fetch("https://eos21xm8bj17yt2.m.pipedream.net", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [itemId] }),
    });

    const data = await res.json();
    if (!data.videoUrl) throw new Error("No video returned");

    // Show result
    document.getElementById("status").classList.add("hidden");
    document.getElementById("result").classList.remove("hidden");

    document.getElementById("videoPreview").src = data.videoUrl;
    document.getElementById("downloadLink").href = data.videoUrl;

  } catch (err) {
    console.error("Error:", err);
    document.getElementById("status").classList.add("hidden");
    document.getElementById("error").classList.remove("hidden");
  }
});
