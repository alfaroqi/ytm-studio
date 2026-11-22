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
})();
