// MAIN-world player bridge for YouTube Music (music.youtube.com only)
// Bridges volume, seek, playback, and track metadata between the isolated overlay and #movie_player
(() => {
  if (window.__amYtmBridgeLoaded) return;
  window.__amYtmBridgeLoaded = true;

  if (typeof window.addEventListener !== "function") return;

  window.addEventListener("am-set-volume", (e) => {
    const detail = e && e.detail;
    if (!detail || typeof detail.volume !== "number") return;
    const vol = Math.max(0, Math.min(100, Math.round(detail.volume)));

    const player = document.querySelector("#movie_player");
    if (player) {
      try {
        if (vol === 0) {
          if (typeof player.mute === "function") player.mute();
          if (typeof player.setVolume === "function") player.setVolume(0);
        } else {
          if (typeof player.unMute === "function") player.unMute();
          if (typeof player.setVolume === "function") player.setVolume(vol);
        }
      } catch (_) {
        // Ignore player API errors
      }
    }

    const sliders = document.querySelectorAll(
      "ytmusic-player-bar #volume-slider, ytmusic-player-bar #expand-volume-slider"
    );
    sliders.forEach((ytmSlider) => {
      try {
        ytmSlider.value = vol;
        ytmSlider.dispatchEvent(new Event("change", { bubbles: true }));
        ytmSlider.dispatchEvent(new CustomEvent("value-change", { bubbles: true }));
      } catch (_) {
        // Ignore slider sync errors
      }
    });
  });

  window.addEventListener("am-seek-to", (e) => {
    const detail = e && e.detail;
    if (!detail || typeof detail.time !== "number" || !Number.isFinite(detail.time)) return;
    const targetTime = Math.max(0, detail.time);
    const player = document.querySelector("#movie_player");
    if (player && typeof player.seekTo === "function") {
      try {
        player.seekTo(targetTime, true);
      } catch (_) {
        // Ignore player API errors
      }
    }
  });

  window.addEventListener("am-set-playback", (e) => {
    const detail = e && e.detail;
    const action = detail && detail.action;
    if (action !== "play" && action !== "pause") return;

    const player = document.querySelector("#movie_player");
    if (player) {
      try {
        if (action === "pause" && typeof player.pauseVideo === "function") {
          player.pauseVideo();
          return;
        }
        if (action === "play" && typeof player.playVideo === "function") {
          player.playVideo();
          return;
        }
      } catch (_) {
        // Fallback to direct video element below
      }
    }

    const video =
      document.querySelector("video.html5-main-video") || document.querySelector("video");
    if (video) {
      if (action === "pause") video.pause();
      else video.play?.().catch?.(() => {});
    }
  });

  window.addEventListener("am-get-track", () => {
    let title = "";
    let artist = "";
    let album = "";
    let artwork = "";

    try {
      const ms =
        typeof navigator !== "undefined" &&
        navigator.mediaSession &&
        navigator.mediaSession.metadata;
      if (ms) {
        title = (ms.title || "").trim();
        artist = (ms.artist || "").trim();
        album = (ms.album || "").trim();
        if (Array.isArray(ms.artwork) && ms.artwork.length > 0) {
          const best = ms.artwork[ms.artwork.length - 1];
          artwork = (best && best.src) || "";
        }
      }
    } catch (_) {}

    if (!title || !artist || !artwork) {
      try {
        const player = document.querySelector("#movie_player");
        const data =
          player && typeof player.getVideoData === "function" ? player.getVideoData() : null;
        if (data) {
          if (!title && data.title) title = String(data.title).trim();
          if (!artist && data.author) artist = String(data.author).trim();
          if (!artwork && data.video_id) {
            artwork = `https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg`;
          }
        }
      } catch (_) {}
    }

    if (title && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent("am-track-info", {
          detail: JSON.stringify({ title, artist, album, artwork }),
        })
      );
    }
  });
})();
