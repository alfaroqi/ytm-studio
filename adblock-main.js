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
    return document.documentElement?.dataset?.amAdblock !== "false";
  }

  function pruneAds(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        pruneAds(item);
      }
      return obj;
    }
    for (const key of AD_KEYS) {
      if (key in obj) {
        delete obj[key];
      }
    }
    if (obj.playerResponse && typeof obj.playerResponse === "object") {
      pruneAds(obj.playerResponse);
    }
    if (obj.response && typeof obj.response === "object") {
      pruneAds(obj.response);
    }
    return obj;
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    if (input && typeof input.href === "string") return input.href;
    return "";
  }

  function isPlayerEndpoint(url) {
    if (typeof url !== "string") return false;
    return url.includes("/youtubei/v1/player") || url.includes("/youtubei/v1/next");
  }

  // 1. Intercept window.fetch for /youtubei/v1/player & /next JSON responses
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const url = getRequestUrl(args[0]);
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

  // 1b. Intercept XMLHttpRequest for YouTube SPA /youtubei/v1/player & /next responses
  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === "function" && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const responseTextDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, "responseText");
    const responseDesc = Object.getOwnPropertyDescriptor(OrigXHR.prototype, "response");

    if (typeof origOpen === "function") {
      OrigXHR.prototype.open = function (method, url, ...rest) {
        this.__amUrl = getRequestUrl(url);
        this.__amPrunedCache = undefined;
        return origOpen.call(this, method, url, ...rest);
      };
    }

    const getPrunedResponseText = (xhr) => {
      if (!responseTextDesc || typeof responseTextDesc.get !== "function") return "";
      const raw = responseTextDesc.get.call(xhr);
      if (!isAdblockEnabled() || !isPlayerEndpoint(xhr.__amUrl) || typeof raw !== "string" || !raw) {
        return raw;
      }
      if (xhr.__amPrunedCache && xhr.__amPrunedCache.raw === raw) {
        return xhr.__amPrunedCache.text;
      }
      try {
        const data = JSON.parse(raw);
        pruneAds(data);
        const text = JSON.stringify(data);
        xhr.__amPrunedCache = { raw, text };
        return text;
      } catch (_) {
        return raw;
      }
    };

    if (responseTextDesc && responseTextDesc.configurable) {
      Object.defineProperty(OrigXHR.prototype, "responseText", {
        configurable: true,
        get() {
          return getPrunedResponseText(this);
        },
      });
    }

    if (responseDesc && responseDesc.configurable) {
      Object.defineProperty(OrigXHR.prototype, "response", {
        configurable: true,
        get() {
          const raw = responseDesc.get.call(this);
          if (!isAdblockEnabled() || !isPlayerEndpoint(this.__amUrl)) {
            return raw;
          }
          if (typeof raw === "string") {
            return getPrunedResponseText(this);
          }
          if (raw && typeof raw === "object") {
            return pruneAds(raw);
          }
          return raw;
        },
      });
    }
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
  }
})();
