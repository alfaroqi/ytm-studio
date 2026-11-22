(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const state = {
    settings: {
      themeEnabled: true,
      themeStyle: "apple", // "apple" | "spotify"
      layoutMode: "desktop", // "desktop" | "mobile"
      animateBg: true,
      showLyricsBtn: true,
      showRomaji: true,
      showTranslation: false,
      adblockEnabled: true,
    },
    overlayOpen: false,
    currentTrackKey: "",
    track: { title: "", artist: "", album: "", artwork: "", duration: 0 },
    lyrics: [], // [{ time: seconds, text: string, romaji?: string, translation?: string }]
    hasCjkLyrics: false,
    hasNonAsciiLyrics: false,
    romajiLoadedForKey: "",
    translationLoadedForKey: "",
    isSynced: false,
    activeIndex: -1,
    offsetSec: 0,
    userScrollingUntil: 0,
    isDraggingSeek: false,
    seekChangedUntil: 0,
    isDraggingVolume: false,
    volumeChangedUntil: 0,
    lastNonZeroVolume: 100,
    rafId: null,
    wasMutedBeforeAd: null,
  };

  const CJK_REGEX =
    /[\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF]/;
  // Matches any non-ASCII letter (ignores English curly quotes, em-dashes, ♪, etc.)
  const NON_ASCII_LETTER_REGEX = /(?!\p{ASCII})\p{L}/u;

  // --- Utilities ---
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function upgradeArtworkUrl(url) {
    if (!url) return "";
    // Upgrade Googleusercontent thumbnail size (e.g. w60-h60 -> w600-h600)
    return url.replace(/=w\d+-h\d+[^&]*/i, "=w600-h600-l90-rj");
  }

  function parseLrc(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split(/\r?\n/);
    const result = [];
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

    for (const rawLine of lines) {
      const matches = [...rawLine.matchAll(timeRegex)];
      if (matches.length === 0) continue;
      // Strip inline enhanced LRC word tags (<mm:ss.xx>) if present
      const text = rawLine
        .replace(timeRegex, "")
        .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, "")
        .trim();
      for (const m of matches) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const msStr = (m[3] || "0").padEnd(3, "0").slice(0, 3);
        const ms = parseInt(msStr, 10);
        const time = min * 60 + sec + ms / 1000;
        result.push({ time, text: text || "♪" });
      }
    }

    result.sort((a, b) => a.time - b.time);
    return result;
  }

  function getVideo() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  // Extract 4 quadrant colors from album artwork to drive the Apple Music Mesh Gradient
  function extractMeshColors(imgUrl) {
    if (!imgUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 4;
        canvas.height = 4;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 4, 4);
        const px = ctx.getImageData(0, 0, 4, 4).data;
        const sample = (x, y) => {
          const i = (y * 4 + x) * 4;
          return `rgb(${px[i]}, ${px[i + 1]}, ${px[i + 2]})`;
        };
        const root = document.documentElement.style;
        root.setProperty("--am-mesh-c1", sample(0, 0));
        root.setProperty("--am-mesh-c2", sample(3, 0));
        root.setProperty("--am-mesh-c3", sample(3, 3));
        root.setProperty("--am-mesh-c4", sample(0, 3));
      } catch (_) {
        // Fallback to default mesh colors if canvas is tainted
      }
    };
    img.src = imgUrl;
  }

  function readCurrentTrack() {
    const bar = document.querySelector("ytmusic-player-bar");
    if (!bar) return null;

    const titleEl = bar.querySelector(".title.ytmusic-player-bar");
    const subtitleEl = bar.querySelector(".byline.ytmusic-player-bar");
    const imgEl = bar.querySelector("img.image.ytmusic-player-bar");
    const video = getVideo();

    const title = titleEl ? titleEl.textContent.trim() : "";
    if (!title) return null;

    let artist = "";
    let album = "";
    if (subtitleEl) {
      const parts = subtitleEl.textContent
        .split("•")
        .map((p) => p.trim())
        .filter(Boolean);
      artist = parts[0] || "";
      if (parts.length >= 2 && !/^\d{4}$/.test(parts[1])) {
        album = parts[1];
      }
    }

    const artwork = upgradeArtworkUrl(imgEl ? imgEl.src : "");
    const duration = video && Number.isFinite(video.duration) ? video.duration : 0;

    return { title, artist, album, artwork, duration };
  }

  // --- Settings ---
  function applySettings() {
    const isSpotify = state.settings.themeStyle === "spotify";
    // Mobile view temporarily disabled (commented out, kept for future use)
    // const isMobile = state.settings.layoutMode === "mobile";
    const isMobile = false;
    document.documentElement.classList.toggle("am-theme-enabled", !!state.settings.themeEnabled);
    document.documentElement.classList.toggle("am-style-spotify", isSpotify);
    document.documentElement.classList.toggle("am-layout-mobile", isMobile);
    document.documentElement.classList.toggle("am-animate-bg", !!state.settings.animateBg);
    document.documentElement.classList.toggle("am-show-romaji", !!state.settings.showRomaji);
    document.documentElement.classList.toggle("am-show-translation", !!state.settings.showTranslation);
    document.documentElement.classList.toggle("am-adblock-enabled", !!state.settings.adblockEnabled);
    document.documentElement.dataset.amAdblock = state.settings.adblockEnabled ? "true" : "false";
    const btn = document.getElementById("am-lyrics-toggle-btn");
    if (btn) {
      btn.style.display = state.settings.showLyricsBtn ? "inline-flex" : "none";
    }
    const romajiBtn = document.getElementById("am-romaji-toggle-btn");
    if (romajiBtn) {
      romajiBtn.style.display = state.hasCjkLyrics ? "inline-flex" : "none";
      romajiBtn.classList.toggle("active", !!state.settings.showRomaji);
      romajiBtn.setAttribute("aria-pressed", state.settings.showRomaji ? "true" : "false");
      romajiBtn.title = state.settings.showRomaji
        ? "Romaji / Pronunciation: On"
        : "Romaji / Pronunciation: Off";
    }
    const translateBtn = document.getElementById("am-translate-toggle-btn");
    if (translateBtn) {
      translateBtn.style.display = state.hasNonAsciiLyrics ? "inline-flex" : "none";
      translateBtn.classList.toggle("active", !!state.settings.showTranslation);
      translateBtn.setAttribute("aria-pressed", state.settings.showTranslation ? "true" : "false");
      translateBtn.title = state.settings.showTranslation
        ? "Translate Lyrics (English): On"
        : "Translate Lyrics (English): Off";
    }
    const badgeLabel = document.getElementById("am-badge-label");
    if (badgeLabel) {
      badgeLabel.textContent = isSpotify
        ? "Spotify Mode • Synced Lyrics"
        : "Apple Music Mode • Synced Lyrics";
    }
    const styleBtn = document.getElementById("am-style-toggle-btn");
    if (styleBtn) {
      styleBtn.textContent = isSpotify ? "Style: Spotify" : "Style: Apple Music";
    }
    const layoutBtn = document.getElementById("am-layout-toggle-btn");
    if (layoutBtn) {
      layoutBtn.textContent = isMobile ? "View: Mobile" : "View: Desktop";
    }
  }

  function safeStorageSet(patch) {
    try {
      if (api && api.runtime && api.runtime.id && api.storage && api.storage.local) {
        api.storage.local.set(patch);
      }
    } catch (_) {
      // Extension context was invalidated (e.g., after reload before tab refresh)
    }
  }

  function safeSendMessage(message, fallback) {
    return new Promise((resolve) => {
      try {
        if (!api || !api.runtime || !api.runtime.id || !api.runtime.sendMessage) {
          resolve(fallback);
          return;
        }
        api.runtime.sendMessage(message, (response) => {
          try {
            if (api.runtime && api.runtime.lastError) {
              resolve(fallback);
              return;
            }
          } catch (_) {
            resolve(fallback);
            return;
          }
          resolve(response || fallback);
        });
      } catch (_) {
        resolve(fallback);
      }
    });
  }

  function loadSettings() {
    try {
      if (!api || !api.runtime || !api.runtime.id || !api.storage || !api.storage.local) {
        applySettings();
        return;
      }
      api.storage.local.get(
        {
          themeEnabled: true,
          themeStyle: "apple",
          layoutMode: "desktop",
          animateBg: true,
          showLyricsBtn: true,
          showRomaji: true,
          showTranslation: false,
          adblockEnabled: true,
        },
        (items) => {
          state.settings = { ...state.settings, ...items };
          applySettings();
        }
      );
    } catch (_) {
      applySettings();
    }
  }

  // --- Fallback Ad Auto-Skipper (for any server-side ad that bypasses network/JSON pruning) ---
  function handleAdPlayback() {
    if (!state.settings.adblockEnabled) return;

    const player = document.querySelector("#movie_player");
    const video = getVideo();
    const isAd =
      !!(player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))) ||
      !!document.querySelector(".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout");

    if (isAd && video) {
      if (state.wasMutedBeforeAd === null) {
        state.wasMutedBeforeAd = video.muted;
      }
      video.muted = true;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = video.duration;
      }
      video.playbackRate = 16;

      // Click any available skip button immediately
      const skipSelectors = [
        ".ytp-skip-ad-button",
        ".ytp-ad-skip-button",
        ".ytp-ad-skip-button-modern",
        "button.ytp-ad-skip-button-modern",
      ];
      for (const sel of skipSelectors) {
        const skipBtn = document.querySelector(sel);
        if (skipBtn) {
          skipBtn.click();
          break;
        }
      }
    } else if (!isAd && video && state.wasMutedBeforeAd !== null) {
      // Restore original mute state and playback speed once the song resumes
      video.muted = state.wasMutedBeforeAd;
      if (video.playbackRate > 4) video.playbackRate = 1;
      state.wasMutedBeforeAd = null;
    }
  }

  // --- FullScreenPlayerView Overlay ---
  function createOverlay() {
    if (document.getElementById("am-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "am-overlay";
    overlay.innerHTML = `
      <div class="am-bg-layer"></div>
      <div class="am-mesh-layer"></div>
      <div class="am-bg-vignette"></div>
      <div class="am-mobile-grabber" id="am-mobile-grabber" title="Close"></div>
      <div class="am-topbar">
        <div class="am-topbar-left">
          <button class="am-back-btn" id="am-back-btn" title="Back (Esc)">
            <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
            <span>Back</span>
          </button>
          <div class="am-badge">
            <span class="am-badge-dot"></span>
            <span id="am-badge-label">Apple Music Mode • Synced Lyrics</span>
          </div>
        </div>
        <div class="am-top-controls">
          <!-- Mobile view toggle temporarily hidden
          <button class="am-pill-btn" id="am-layout-toggle-btn" title="Switch between Desktop and Mobile layout">View: Desktop</button>
          -->
          <button class="am-pill-btn" id="am-style-toggle-btn" title="Switch between Apple Music and Spotify style">Style: Apple Music</button>
          <button class="am-pill-btn" id="am-offset-minus" title="Shift lyrics earlier by 0.5s">-0.5s</button>
          <span class="am-pill-btn" id="am-offset-label" style="cursor:default;">Sync: 0.0s</span>
          <button class="am-pill-btn" id="am-offset-plus" title="Shift lyrics later by 0.5s">+0.5s</button>
          <button class="am-pill-btn" id="am-fullscreen-btn" title="Toggle Browser Fullscreen">Fullscreen</button>
          <button class="am-pill-btn" id="am-close-btn">Close (Esc)</button>
        </div>
      </div>
      <div class="am-main">
        <div class="am-left">
          <div class="am-artwork-wrap" id="am-artwork-wrap">
            <img id="am-artwork-img" alt="Album Art" />
          </div>
          <div class="am-meta">
            <div class="am-title" id="am-title">Loading track...</div>
            <div class="am-artist" id="am-artist"></div>
          </div>
          <div class="am-progress-wrap">
            <div class="am-progress-hit" id="am-progress-bar" role="slider" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
              <div class="am-progress-bar">
                <div class="am-progress-fill" id="am-progress-fill"></div>
              </div>
            </div>
            <div class="am-time-row">
              <span id="am-time-cur">0:00</span>
              <span id="am-time-dur">0:00</span>
            </div>
          </div>
          <div class="am-controls">
            <button class="am-ctrl-btn secondary" id="am-shuffle-btn" title="Shuffle">
              <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
            </button>
            <button class="am-ctrl-btn" id="am-prev-btn" title="Previous">
              <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button class="am-ctrl-btn play-btn" id="am-play-btn" title="Play / Pause">
              <svg viewBox="0 0 24 24" id="am-play-icon"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>
            <button class="am-ctrl-btn" id="am-next-btn" title="Next">
              <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
            <button class="am-ctrl-btn secondary" id="am-repeat-btn" title="Repeat">
              <svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
            </button>
          </div>
          <div class="am-volume-row" id="am-volume-row">
            <div class="am-vol-popover-anchor">
              <button type="button" class="am-vol-icon-btn" id="am-vol-mute-btn" title="Volume (Click for vertical slider)" aria-expanded="false">
                <svg viewBox="0 0 24 24"><path d="M7 9v6h4l5 5V4l-5 5H7z"/></svg>
              </button>
              <div class="am-vol-popover" id="am-vol-popover" role="dialog" aria-label="Vertical Volume Control">
                <span class="am-vol-popover-pct" id="am-vol-popover-pct">100%</span>
                <div class="am-vol-vbar-wrap" id="am-vol-vbar" role="slider" aria-label="Volume" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" tabindex="0">
                  <div class="am-vol-vbar-track">
                    <div class="am-vol-vbar-fill" id="am-vol-vbar-fill"></div>
                  </div>
                </div>
                <button type="button" class="am-vol-popover-mute" id="am-vol-popover-mute" title="Mute / Unmute (M)">
                  <svg viewBox="0 0 24 24" id="am-vol-popover-mute-icon"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                </button>
              </div>
            </div>
            <div class="am-volume-bar-wrap" id="am-volume-bar" role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100" tabindex="0" title="Volume">
              <div class="am-volume-bar-track">
                <div class="am-volume-bar-fill" id="am-volume-fill"></div>
              </div>
            </div>
            <button type="button" class="am-vol-icon-btn" id="am-vol-max-btn" title="Volume Up">
              <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            </button>
            <span class="am-vol-pct-label" id="am-vol-pct-label">100%</span>
          </div>
        </div>
        <div class="am-right">
          <div class="am-lyrics-fabs">
            <button class="am-fab" id="am-romaji-toggle-btn" aria-label="Toggle Romaji / Pronunciation" title="Romaji / Pronunciation: On">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <text x="12" y="15.5" text-anchor="middle" font-size="11.5" font-weight="800" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif" letter-spacing="-0.4">Ro</text>
                <rect x="6" y="18" width="12" height="1.8" rx="0.9" opacity="0.75"/>
              </svg>
            </button>
            <button class="am-fab" id="am-translate-toggle-btn" aria-label="Toggle English Translation" title="Translate Lyrics (English): Off">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>
              </svg>
            </button>
          </div>
          <div class="am-lyrics-scroll" id="am-lyrics-scroll">
            <div class="am-lyrics-status">Play a track on YouTube Music to begin...</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Event bindings
    document.getElementById("am-back-btn").addEventListener("click", () => toggleOverlay(false));
    document.getElementById("am-mobile-grabber").addEventListener("click", () => toggleOverlay(false));
    /* Mobile view toggle listener temporarily disabled
    document.getElementById("am-layout-toggle-btn").addEventListener("click", () => {
      const next = state.settings.layoutMode === "mobile" ? "desktop" : "mobile";
      state.settings.layoutMode = next;
      applySettings();
      if (api.storage && api.storage.local) {
        api.storage.local.set({ layoutMode: next });
      }
    });
    */
    document.getElementById("am-romaji-toggle-btn").addEventListener("click", () => {
      const next = !state.settings.showRomaji;
      state.settings.showRomaji = next;
      applySettings();
      safeStorageSet({ showRomaji: next });
      if (next && state.hasCjkLyrics && state.romajiLoadedForKey !== state.currentTrackKey) {
        loadRomajiForCurrentLyrics(state.currentTrackKey);
      }
    });
    document.getElementById("am-translate-toggle-btn").addEventListener("click", () => {
      const next = !state.settings.showTranslation;
      state.settings.showTranslation = next;
      applySettings();
      safeStorageSet({ showTranslation: next });
      if (next && state.hasNonAsciiLyrics && state.translationLoadedForKey !== state.currentTrackKey) {
        loadTranslationForCurrentLyrics(state.currentTrackKey);
      }
    });
    document.getElementById("am-style-toggle-btn").addEventListener("click", () => {
      const next = state.settings.themeStyle === "spotify" ? "apple" : "spotify";
      state.settings.themeStyle = next;
      applySettings();
      safeStorageSet({ themeStyle: next });
    });
    document.getElementById("am-close-btn").addEventListener("click", () => toggleOverlay(false));
    document.getElementById("am-offset-minus").addEventListener("click", () => updateOffset(-0.5));
    document.getElementById("am-offset-plus").addEventListener("click", () => updateOffset(0.5));

    document.getElementById("am-fullscreen-btn").addEventListener("click", () => {
      if (!document.fullscreenElement) {
        overlay.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    });

    document.getElementById("am-play-btn").addEventListener("click", () => {
      const btn = document.querySelector("#play-pause-button");
      if (btn) btn.click();
      else {
        const v = getVideo();
        if (v) v.paused ? v.play() : v.pause();
      }
    });

    document.getElementById("am-prev-btn").addEventListener("click", () => {
      document.querySelector(".previous-button")?.click();
    });

    document.getElementById("am-next-btn").addEventListener("click", () => {
      document.querySelector(".next-button")?.click();
    });

    document.getElementById("am-shuffle-btn").addEventListener("click", () => {
      document.querySelector("ytmusic-player-bar .shuffle")?.click();
    });

    document.getElementById("am-repeat-btn").addEventListener("click", () => {
      document.querySelector("ytmusic-player-bar .repeat")?.click();
    });

    const volBar = document.getElementById("am-volume-bar");
    const volRow = document.getElementById("am-volume-row");

    const setVolumeFromPointer = (clientX) => {
      const rect = volBar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      applyPlayerVolume(Math.round(ratio * 100));
    };

    volBar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      state.isDraggingVolume = true;
      volBar.classList.add("dragging");
      volBar.setPointerCapture?.(e.pointerId);
      setVolumeFromPointer(e.clientX);
    });
    volBar.addEventListener("pointermove", (e) => {
      if (!state.isDraggingVolume) return;
      setVolumeFromPointer(e.clientX);
    });
    const endVolDrag = (e) => {
      if (!state.isDraggingVolume) return;
      state.isDraggingVolume = false;
      volBar.classList.remove("dragging");
      if (e && e.pointerId !== undefined) {
        try {
          volBar.releasePointerCapture?.(e.pointerId);
        } catch (_) {}
      }
    };
    volBar.addEventListener("pointerup", endVolDrag);
    volBar.addEventListener("pointercancel", endVolDrag);

    const volMuteBtn = document.getElementById("am-vol-mute-btn");
    const volPopover = document.getElementById("am-vol-popover");
    const volVbar = document.getElementById("am-vol-vbar");

    const toggleMute = () => {
      const cur = readPlayerVolume();
      if (cur > 0) {
        state.lastNonZeroVolume = cur;
        applyPlayerVolume(0);
      } else {
        applyPlayerVolume(state.lastNonZeroVolume || 50);
      }
    };

    const setVolPopoverOpen = (open) => {
      volPopover.classList.toggle("open", open);
      volMuteBtn.setAttribute("aria-expanded", open ? "true" : "false");
    };

    volMuteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !volPopover.classList.contains("open");
      setVolPopoverOpen(willOpen);
      if (willOpen) {
        updateVolumeSliderVisual(readPlayerVolume());
      }
    });

    volPopover.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    overlay.addEventListener("click", () => {
      if (volPopover.classList.contains("open")) {
        setVolPopoverOpen(false);
      }
    });

    const setVolumeFromVerticalPointer = (clientY) => {
      const rect = volVbar.getBoundingClientRect();
      if (rect.height <= 0) return;
      const ratio = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
      applyPlayerVolume(Math.round(ratio * 100));
    };

    volVbar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      state.isDraggingVolume = true;
      volVbar.classList.add("dragging");
      volVbar.setPointerCapture?.(e.pointerId);
      setVolumeFromVerticalPointer(e.clientY);
    });
    volVbar.addEventListener("pointermove", (e) => {
      if (!state.isDraggingVolume) return;
      setVolumeFromVerticalPointer(e.clientY);
    });
    const endVerticalVolDrag = (e) => {
      if (!state.isDraggingVolume) return;
      state.isDraggingVolume = false;
      volVbar.classList.remove("dragging");
      if (e && e.pointerId !== undefined) {
        try {
          volVbar.releasePointerCapture?.(e.pointerId);
        } catch (_) {}
      }
    };
    volVbar.addEventListener("pointerup", endVerticalVolDrag);
    volVbar.addEventListener("pointercancel", endVerticalVolDrag);

    document.getElementById("am-vol-popover-mute").addEventListener("click", toggleMute);

    document.getElementById("am-vol-max-btn").addEventListener("click", () => {
      const cur = readPlayerVolume();
      applyPlayerVolume(Math.min(100, cur + 10));
    });

    volRow.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 5 : -5;
        applyPlayerVolume(readPlayerVolume() + delta);
      },
      { passive: false }
    );

    const progressBar = document.getElementById("am-progress-bar");
    const seekFromPointer = (clientX) => {
      const video = getVideo();
      if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const rect = progressBar.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekToTime(ratio * video.duration, video.duration);
    };

    progressBar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      state.isDraggingSeek = true;
      progressBar.classList.add("dragging");
      progressBar.setPointerCapture?.(e.pointerId);
      seekFromPointer(e.clientX);
    });
    progressBar.addEventListener("pointermove", (e) => {
      if (!state.isDraggingSeek) return;
      seekFromPointer(e.clientX);
    });
    const endSeekDrag = (e) => {
      if (!state.isDraggingSeek) return;
      state.isDraggingSeek = false;
      progressBar.classList.remove("dragging");
      if (e && e.pointerId !== undefined) {
        try {
          progressBar.releasePointerCapture?.(e.pointerId);
        } catch (_) {}
      }
    };
    progressBar.addEventListener("pointerup", endSeekDrag);
    progressBar.addEventListener("pointercancel", endSeekDrag);

    const scrollEl = document.getElementById("am-lyrics-scroll");
    scrollEl.addEventListener(
      "wheel",
      () => {
        state.userScrollingUntil = Date.now() + 4500;
      },
      { passive: true }
    );
  }

  function readPlayerVolume() {
    const video = getVideo();
    if (video && video.muted) return 0;

    const ytmSlider = document.querySelector("ytmusic-player-bar #volume-slider");
    if (ytmSlider) {
      const raw = ytmSlider.getAttribute("aria-valuenow") ?? ytmSlider.getAttribute("value");
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.min(100, Math.round(parsed)));
      }
    }

    if (video && Number.isFinite(video.volume)) {
      return Math.max(0, Math.min(100, Math.round(video.volume * 100)));
    }
    return 100;
  }

  function updateVolumeSliderVisual(volPct) {
    const clamped = Math.max(0, Math.min(100, Math.round(volPct)));
    const volBar = document.getElementById("am-volume-bar");
    const volFill = document.getElementById("am-volume-fill");
    const volPctLabel = document.getElementById("am-vol-pct-label");
    const volVbar = document.getElementById("am-vol-vbar");
    const volVbarFill = document.getElementById("am-vol-vbar-fill");
    const volPopoverPct = document.getElementById("am-vol-popover-pct");
    if (volBar) volBar.setAttribute("aria-valuenow", String(clamped));
    if (volFill) volFill.style.width = `${clamped}%`;
    if (volPctLabel) volPctLabel.textContent = `${clamped}%`;
    if (volVbar) volVbar.setAttribute("aria-valuenow", String(clamped));
    if (volVbarFill) volVbarFill.style.height = `${clamped}%`;
    if (volPopoverPct) volPopoverPct.textContent = `${clamped}%`;
  }

  function seekToTime(seconds, knownDuration) {
    const video = getVideo();
    const dur =
      Number.isFinite(knownDuration) && knownDuration > 0
        ? knownDuration
        : video && Number.isFinite(video.duration)
        ? video.duration
        : 0;
    const clamped = Math.max(0, dur > 0 ? Math.min(dur, seconds) : seconds);
    state.seekChangedUntil = Date.now() + 450;

    const fill = document.getElementById("am-progress-fill");
    const curEl = document.getElementById("am-time-cur");
    const progressBar = document.getElementById("am-progress-bar");
    if (fill && dur > 0) fill.style.width = `${(clamped / dur) * 100}%`;
    if (curEl) curEl.textContent = formatTime(clamped);
    if (progressBar && dur > 0) {
      progressBar.setAttribute("aria-valuenow", String(Math.round((clamped / dur) * 100)));
    }

    // Bridge to MAIN world (#movie_player.seekTo) + direct video fallback
    window.dispatchEvent(new CustomEvent("am-seek-to", { detail: { time: clamped } }));
    if (video) {
      video.currentTime = clamped;
    }
  }

  function applyPlayerVolume(volPct) {
    const clamped = Math.max(0, Math.min(100, Math.round(volPct)));
    if (clamped > 0) state.lastNonZeroVolume = clamped;
    state.volumeChangedUntil = Date.now() + 700;
    updateVolumeSliderVisual(clamped);

    // Bridge to MAIN world (#movie_player.setVolume + YTM's #volume-slider)
    window.dispatchEvent(new CustomEvent("am-set-volume", { detail: { volume: clamped } }));

    // Fallback direct video element update
    const video = getVideo();
    if (video) {
      video.volume = clamped / 100;
      video.muted = clamped === 0;
    }
  }

  function updateOffset(delta) {
    state.offsetSec = Math.round((state.offsetSec + delta) * 10) / 10;
    const lbl = document.getElementById("am-offset-label");
    if (lbl) {
      const sign = state.offsetSec > 0 ? "+" : "";
      lbl.textContent = `Sync: ${sign}${state.offsetSec.toFixed(1)}s`;
    }
  }

  function toggleOverlay(forceState) {
    createOverlay();
    state.overlayOpen = typeof forceState === "boolean" ? forceState : !state.overlayOpen;
    const overlay = document.getElementById("am-overlay");
    const btn = document.getElementById("am-lyrics-toggle-btn");
    if (overlay) overlay.classList.toggle("open", state.overlayOpen);
    if (btn) btn.classList.toggle("active", state.overlayOpen);
    if (!state.overlayOpen && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
    if (state.overlayOpen) {
      renderTrackMeta();
      startSyncLoop();
    }
  }

  function injectPlayerBarButton() {
    if (document.getElementById("am-lyrics-toggle-btn")) return;
    const rightControls = document.querySelector("ytmusic-player-bar .right-controls-buttons");
    if (!rightControls) return;

    const btn = document.createElement("button");
    btn.id = "am-lyrics-toggle-btn";
    btn.title = "Open Apple Music Mode & Synced Lyrics (Press L)";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      <span>Lyrics</span>
    `;
    btn.style.display = state.settings.showLyricsBtn ? "inline-flex" : "none";
    btn.addEventListener("click", () => toggleOverlay());
    // Place after volume/repeat/shuffle (before the expand caret) so it never overlaps YTM's volume slider
    const expandBtn = rightControls.querySelector(".toggle-player-page-button");
    if (expandBtn) {
      rightControls.insertBefore(btn, expandBtn);
    } else {
      rightControls.appendChild(btn);
    }
  }

  function renderTrackMeta() {
    const { title, artist, artwork } = state.track;
    if (artwork) {
      document.documentElement.style.setProperty("--am-artwork-url", `url("${artwork}")`);
      extractMeshColors(artwork);
    }
    const img = document.getElementById("am-artwork-img");
    const titleEl = document.getElementById("am-title");
    const artistEl = document.getElementById("am-artist");
    if (img && artwork) img.src = artwork;
    if (titleEl) titleEl.textContent = title || "No track playing";
    if (artistEl) artistEl.textContent = artist || "";
  }

  function renderLyricsLoading() {
    const container = document.getElementById("am-lyrics-scroll");
    if (!container) return;
    container.innerHTML = `<div class="am-lyrics-status">Searching for synced lyrics...</div>`;
  }

  function renderLyricsList() {
    const container = document.getElementById("am-lyrics-scroll");
    if (!container) return;

    if (!state.lyrics.length) {
      container.innerHTML = `<div class="am-lyrics-status">Lyrics are not available for this track.</div>`;
      return;
    }

    container.innerHTML = "";

    // Intro / instrumental interlude indicator (3 pulsing dots)
    if (state.isSynced) {
      const interlude = document.createElement("div");
      interlude.id = "am-interlude";
      interlude.className = "am-interlude";
      interlude.innerHTML = "<span></span><span></span><span></span>";
      container.appendChild(interlude);
    }

    state.lyrics.forEach((line, idx) => {
      const p = document.createElement("div");
      p.className = state.isSynced ? "am-lyric-line" : "am-lyric-line plain";
      p.dataset.index = String(idx);

      const textEl = document.createElement("div");
      textEl.className = "am-lyric-text";
      textEl.textContent = line.text;
      p.appendChild(textEl);

      if (line.romaji) {
        p.classList.add("has-romaji");
        const romajiEl = document.createElement("div");
        romajiEl.className = "am-lyric-romaji";
        romajiEl.textContent = line.romaji;
        p.appendChild(romajiEl);
      }

      if (line.translation) {
        const transEl = document.createElement("div");
        transEl.className = "am-lyric-translation";
        transEl.textContent = line.translation;
        p.appendChild(transEl);
      }

      if (state.isSynced) {
        p.addEventListener("click", () => {
          seekToTime(Math.max(0, line.time - state.offsetSec));
          state.userScrollingUntil = 0;
        });
      }
      container.appendChild(p);
    });
    state.activeIndex = -1;
  }

  function applyRomajiToDom() {
    const container = document.getElementById("am-lyrics-scroll");
    if (!container) return;
    const lineNodes = container.querySelectorAll(".am-lyric-line");
    lineNodes.forEach((node, idx) => {
      const line = state.lyrics[idx];
      if (!line || !line.romaji) return;
      node.classList.add("has-romaji");
      let romajiEl = node.querySelector(".am-lyric-romaji");
      if (!romajiEl) {
        romajiEl = document.createElement("div");
        romajiEl.className = "am-lyric-romaji";
        const transEl = node.querySelector(".am-lyric-translation");
        if (transEl) node.insertBefore(romajiEl, transEl);
        else node.appendChild(romajiEl);
      }
      romajiEl.textContent = line.romaji;
    });
  }

  function applyTranslationToDom() {
    const container = document.getElementById("am-lyrics-scroll");
    if (!container) return;
    const lineNodes = container.querySelectorAll(".am-lyric-line");
    lineNodes.forEach((node, idx) => {
      const line = state.lyrics[idx];
      if (!line || !line.translation) return;
      let transEl = node.querySelector(".am-lyric-translation");
      if (!transEl) {
        transEl = document.createElement("div");
        transEl.className = "am-lyric-translation";
        node.appendChild(transEl);
      }
      transEl.textContent = line.translation;
    });
  }

  async function loadRomajiForCurrentLyrics(trackKey) {
    if (!state.lyrics.length) return;
    try {
      const res = await safeSendMessage(
        {
          type: "ROMANIZE_LYRICS",
          payload: { lines: state.lyrics.map((l) => l.text) },
        },
        { language: null, romaji: [] }
      );

      if (`${state.track.title}|||${state.track.artist}` !== trackKey) return;
      if (res && Array.isArray(res.romaji)) {
        state.romajiLoadedForKey = trackKey;
        for (let i = 0; i < state.lyrics.length; i++) {
          state.lyrics[i].romaji = res.romaji[i] || "";
        }
        applyRomajiToDom();
      }
    } catch (_) {
      // Ignore romanization errors; original lyrics remain visible
    }
  }

  async function loadTranslationForCurrentLyrics(trackKey) {
    if (!state.lyrics.length) return;
    try {
      const res = await safeSendMessage(
        {
          type: "TRANSLATE_LYRICS",
          payload: { lines: state.lyrics.map((l) => l.text), targetLang: "en" },
        },
        { translations: [] }
      );

      if (`${state.track.title}|||${state.track.artist}` !== trackKey) return;
      if (res && Array.isArray(res.translations)) {
        state.translationLoadedForKey = trackKey;
        for (let i = 0; i < state.lyrics.length; i++) {
          state.lyrics[i].translation = res.translations[i] || "";
        }
        applyTranslationToDom();
      }
    } catch (_) {
      // Ignore translation errors; original lyrics remain visible
    }
  }

  async function loadLyricsForCurrentTrack() {
    const key = `${state.track.title}|||${state.track.artist}`;
    state.offsetSec = 0;
    state.hasCjkLyrics = false;
    state.hasNonAsciiLyrics = false;
    state.romajiLoadedForKey = "";
    state.translationLoadedForKey = "";
    applySettings();
    const lbl = document.getElementById("am-offset-label");
    if (lbl) lbl.textContent = "Sync: 0.0s";

    renderLyricsLoading();

    try {
      const res = await safeSendMessage(
        {
          type: "FETCH_LYRICS",
          payload: {
            title: state.track.title,
            artist: state.track.artist,
            album: state.track.album,
            duration: state.track.duration,
          },
        },
        { found: false }
      );

      // Ignore stale response if track changed while fetching
      if (`${state.track.title}|||${state.track.artist}` !== key) return;

      if (res && res.found && res.syncedLyrics) {
        state.lyrics = parseLrc(res.syncedLyrics);
        state.isSynced = state.lyrics.length > 0;
      } else if (res && res.found && res.plainLyrics) {
        state.lyrics = res.plainLyrics
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ time: -1, text }));
        state.isSynced = false;
      } else {
        state.lyrics = [];
        state.isSynced = false;
      }
    } catch (_) {
      state.lyrics = [];
      state.isSynced = false;
    }

    renderLyricsList();

    state.hasCjkLyrics = state.lyrics.some((l) => CJK_REGEX.test(l.text));
    state.hasNonAsciiLyrics =
      state.hasCjkLyrics || state.lyrics.some((l) => NON_ASCII_LETTER_REGEX.test(l.text));
    applySettings();
    if (state.hasCjkLyrics && state.settings.showRomaji) {
      loadRomajiForCurrentLyrics(key);
    }
    if (state.hasNonAsciiLyrics && state.settings.showTranslation) {
      loadTranslationForCurrentLyrics(key);
    }
  }

  // --- 60fps Sync & Karaoke Sweep Loop ---
  function syncFrame() {
    const video = getVideo();
    if (video && state.overlayOpen) {
      const cur = video.currentTime || 0;
      const dur = video.duration || 0;

      const fill = document.getElementById("am-progress-fill");
      const curEl = document.getElementById("am-time-cur");
      const durEl = document.getElementById("am-time-dur");
      const artWrap = document.getElementById("am-artwork-wrap");
      const playIcon = document.getElementById("am-play-icon");

      if (!state.isDraggingSeek && Date.now() > state.seekChangedUntil) {
        if (fill && dur > 0) fill.style.width = `${(cur / dur) * 100}%`;
        if (curEl) curEl.textContent = formatTime(cur);
      }
      if (durEl) durEl.textContent = formatTime(dur);
      if (artWrap) artWrap.classList.toggle("paused", video.paused);
      if (!state.isDraggingVolume && Date.now() > state.volumeChangedUntil) {
        updateVolumeSliderVisual(readPlayerVolume());
      }
      if (playIcon) {
        playIcon.innerHTML = video.paused
          ? '<path d="M8 5v14l11-7z"/>'
          : '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
      }

      if (state.isSynced && state.lyrics.length > 0) {
        const effectiveTime = cur + state.offsetSec + 0.15;
        let newIndex = -1;
        for (let i = 0; i < state.lyrics.length; i++) {
          if (state.lyrics[i].time <= effectiveTime) {
            newIndex = i;
          } else {
            break;
          }
        }

        // Toggle intro interlude indicator before the first line
        const interlude = document.getElementById("am-interlude");
        if (interlude) {
          interlude.classList.toggle("visible", newIndex === -1 && state.lyrics[0].time > 2.5);
        }

        const container = document.getElementById("am-lyrics-scroll");
        if (container) {
          const lineNodes = container.querySelectorAll(".am-lyric-line");

          if (newIndex !== state.activeIndex) {
            state.activeIndex = newIndex;
            lineNodes.forEach((node, i) => {
              node.classList.toggle("active", i === newIndex);
              node.classList.toggle("past", i < newIndex);
              node.classList.toggle("near", Math.abs(i - newIndex) === 1);
            });
            if (newIndex >= 0 && lineNodes[newIndex] && Date.now() > state.userScrollingUntil) {
              lineNodes[newIndex].scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }

          // Smooth karaoke sweep progress on active line
          if (newIndex >= 0 && lineNodes[newIndex]) {
            const start = state.lyrics[newIndex].time;
            const nextStart =
              newIndex + 1 < state.lyrics.length
                ? state.lyrics[newIndex + 1].time
                : Math.max(start + 4, dur);
            const span = Math.max(0.4, nextStart - start);
            const pct = Math.max(0, Math.min(100, ((effectiveTime - start) / span) * 100));
            lineNodes[newIndex].style.setProperty("--am-line-progress", `${pct.toFixed(1)}%`);
          }
        }
      }
    }

    state.rafId = requestAnimationFrame(syncFrame);
  }

  function startSyncLoop() {
    if (!state.rafId) {
      state.rafId = requestAnimationFrame(syncFrame);
    }
  }

  // --- Track Polling ---
  function checkTrackChange() {
    injectPlayerBarButton();
    const info = readCurrentTrack();
    if (!info) return;

    const key = `${info.title}|||${info.artist}`;
    if (key !== state.currentTrackKey) {
      state.currentTrackKey = key;
      state.track = info;
      createOverlay();
      renderTrackMeta();
      loadLyricsForCurrentTrack();
    } else if (info.artwork && info.artwork !== state.track.artwork) {
      state.track.artwork = info.artwork;
      renderTrackMeta();
    }
  }

  // Keyboard shortcuts: L = toggle overlay, Esc = close
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) {
      return;
    }
    if (e.key === "Escape" && state.overlayOpen) {
      toggleOverlay(false);
    } else if ((e.key === "l" || e.key === "L") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      toggleOverlay();
    } else if (state.overlayOpen && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        applyPlayerVolume(readPlayerVolume() + 5);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        applyPlayerVolume(readPlayerVolume() - 5);
      } else if (e.key === "m" || e.key === "M") {
        const cur = readPlayerVolume();
        if (cur > 0) {
          state.lastNonZeroVolume = cur;
          applyPlayerVolume(0);
        } else {
          applyPlayerVolume(state.lastNonZeroVolume || 50);
        }
      }
    }
  });

  // Listen for settings updates from storage AND direct popup messages (instant apply)
  function mergeAndApplySettings(patch) {
    if (!patch || typeof patch !== "object") return;
    for (const k of Object.keys(patch)) {
      if (k in state.settings) {
        state.settings[k] = patch[k];
      }
    }
    applySettings();
    if (
      patch.showRomaji &&
      state.hasCjkLyrics &&
      state.romajiLoadedForKey !== state.currentTrackKey
    ) {
      loadRomajiForCurrentLyrics(state.currentTrackKey);
    }
    if (
      patch.showTranslation &&
      state.hasNonAsciiLyrics &&
      state.translationLoadedForKey !== state.currentTrackKey
    ) {
      loadTranslationForCurrentLyrics(state.currentTrackKey);
    }
  }

  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes) => {
      const patch = {};
      for (const k of Object.keys(changes)) {
        if (k in state.settings) {
          patch[k] = changes[k].newValue;
        }
      }
      mergeAndApplySettings(patch);
    });
  }

  if (api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === "APPLY_SETTINGS") {
        mergeAndApplySettings(message.patch);
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  // Init
  loadSettings();
  createOverlay();
  setInterval(checkTrackChange, 1000);
  setInterval(handleAdPlayback, 250);
  startSyncLoop();
})();
