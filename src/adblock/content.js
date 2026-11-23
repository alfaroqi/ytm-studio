// Isolated-world adblock controller & SPA-aware auto-skipper
// Runs at document_start on both music.youtube.com and www.youtube.com
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const SKIP_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    "button.ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-slot button",
  ];

  let adblockEnabled = true;
  let wasMutedBeforeAd = null;
  let observedPlayer = null;
  let playerObserver = null;

  function applyAdblockState() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("am-adblock-enabled", !!adblockEnabled);
    root.dataset.amAdblock = adblockEnabled ? "true" : "false";
  }

  function getVideo() {
    return (
      document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector("video")
    );
  }

  function handleAdPlayback() {
    if (!adblockEnabled) return;

    const player = document.querySelector("#movie_player");
    const video = getVideo();
    const isAd =
      !!(
        player &&
        (player.classList.contains("ad-showing") ||
          player.classList.contains("ad-interrupting"))
      ) ||
      !!document.querySelector(
        ".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout"
      );

    if (isAd && video) {
      if (wasMutedBeforeAd === null) {
        wasMutedBeforeAd = video.muted;
      }
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
      video.playbackRate = 16;
      if (video.paused) {
        video.play?.().catch?.(() => {});
      }

      for (const sel of SKIP_SELECTORS) {
        const skipBtn = document.querySelector(sel);
        if (skipBtn) {
          skipBtn.click();
          break;
        }
      }
    } else if (!isAd && video && wasMutedBeforeAd !== null) {
      video.muted = wasMutedBeforeAd;
      if (video.playbackRate > 4) video.playbackRate = 1;
      wasMutedBeforeAd = null;
    }
  }

  function observePlayer() {
    if (typeof MutationObserver !== "function") return;
    const player = document.querySelector("#movie_player");
    if (!player || player === observedPlayer) return;

    if (playerObserver) {
      playerObserver.disconnect();
    }
    observedPlayer = player;
    playerObserver = new MutationObserver(() => {
      handleAdPlayback();
    });
    playerObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class"],
    });
    handleAdPlayback();
  }

  function loadSettings() {
    applyAdblockState();
    try {
      if (api && api.runtime && api.runtime.id && api.storage && api.storage.local) {
        api.storage.local.get({ adblockEnabled: true }, (items) => {
          adblockEnabled = !!items.adblockEnabled;
          applyAdblockState();
          if (adblockEnabled) handleAdPlayback();
        });
      }
    } catch (_) {
      // Fallback to default enabled
    }
  }

  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes) => {
      if (changes.adblockEnabled) {
        adblockEnabled = !!changes.adblockEnabled.newValue;
        applyAdblockState();
        if (adblockEnabled) handleAdPlayback();
      }
    });
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === "APPLY_SETTINGS" && message.patch) {
        if ("adblockEnabled" in message.patch) {
          adblockEnabled = !!message.patch.adblockEnabled;
          applyAdblockState();
          if (adblockEnabled) handleAdblockPlayback();
        }
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  function handleAdblockPlayback() {
    observePlayer();
    handleAdPlayback();
  }

  loadSettings();

  if (typeof window.addEventListener === "function") {
    window.addEventListener("yt-navigate-finish", handleAdblockPlayback);
    window.addEventListener("DOMContentLoaded", handleAdblockPlayback);
  }

  setInterval(handleAdblockPlayback, 250);
})();
