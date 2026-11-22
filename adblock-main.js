// MAIN-world JSON-prune scriptlet for YouTube Music
// Inspired by uBlock Origin Lite's json-prune scriptlets for /youtubei/v1/player
(() => {
  if (window.__amAdblockMainLoaded) return;
  window.__amAdblockMainLoaded = true;

  const AD_KEYS = [
    "adPlacements",
    "playerAds",
    "adSlots",
    "adBreakHeartbeatParams",
    "adBreakParams",
  ];

  function isAdblockEnabled() {
    // Content script sets data-am-adblock="false" on <html> if user turns off adblock
    return document.documentElement.dataset.amAdblock !== "false";
  }

  function pruneAds(obj) {
    if (!obj || typeof obj !== "object") return obj;
    for (const key of AD_KEYS) {
      if (key in obj) {
        delete obj[key];
      }
    }
    if (obj.playerResponse && typeof obj.playerResponse === "object") {
      pruneAds(obj.playerResponse);
    }
    return obj;
  }

  function isPlayerEndpoint(url) {
    if (typeof url !== "string") return false;
    return url.includes("/youtubei/v1/player") || url.includes("/youtubei/v1/next");
  }

  // 1. Intercept window.fetch for /youtubei/v1/player JSON responses
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const response = await origFetch.apply(this, args);
      if (!isAdblockEnabled() || !isPlayerEndpoint(url)) {
        return response;
      }
      try {
        const clone = response.clone();
        const data = await clone.json();
        pruneAds(data);
        const body = JSON.stringify(data);
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (_) {
        return response;
      }
    };
  }

  // 2. Prune ytInitialPlayerResponse if present on page bootstrap
  let initialPlayer = window.ytInitialPlayerResponse;
  if (initialPlayer && isAdblockEnabled()) {
    pruneAds(initialPlayer);
  }
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get() {
        return initialPlayer;
      },
      set(val) {
        initialPlayer = isAdblockEnabled() ? pruneAds(val) : val;
      },
    });
  } catch (_) {
    // Ignore if already non-configurable
  }

  // 3. Bridge volume changes from the isolated lyrics overlay to YTM's #movie_player & slider
  if (typeof window.addEventListener === "function") {
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
  }
})();
