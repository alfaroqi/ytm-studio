// MAIN-world JSON-prune scriptlet for YouTube Music & YouTube
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
})();
