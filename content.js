(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const state = {
    settings: {
      themeEnabled: true,
      themeStyle: "apple", // "apple" | "spotify"
      layoutMode: "desktop", // "desktop" | "mobile"
      animateBg: true,
      showLyricsBtn: true,
      adblockEnabled: true,
    },
    overlayOpen: false,
    currentTrackKey: "",
    track: { title: "", artist: "", album: "", artwork: "", duration: 0 },
    lyrics: [], // [{ time: seconds, text: string }]
    isSynced: false,
    activeIndex: -1,
    offsetSec: 0,
    userScrollingUntil: 0,
    rafId: null,
    wasMutedBeforeAd: null,
  };

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
    document.documentElement.classList.toggle("am-adblock-enabled", !!state.settings.adblockEnabled);
    document.documentElement.dataset.amAdblock = state.settings.adblockEnabled ? "true" : "false";
    const btn = document.getElementById("am-lyrics-toggle-btn");
    if (btn) {
      btn.style.display = state.settings.showLyricsBtn ? "inline-flex" : "none";
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

  function loadSettings() {
    if (!api.storage || !api.storage.local) {
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
        adblockEnabled: true,
      },
      (items) => {
        state.settings = { ...state.settings, ...items };
        applySettings();
      }
    );
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
            <div class="am-progress-bar" id="am-progress-bar">
              <div class="am-progress-fill" id="am-progress-fill"></div>
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
          <div class="am-volume-row">
            <svg viewBox="0 0 24 24"><path d="M7 9v6h4l5 5V4l-5 5H7z"/></svg>
            <input type="range" min="0" max="100" value="100" class="am-volume-slider" id="am-volume-slider" title="Volume" />
            <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
          </div>
        </div>
        <div class="am-right">
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
    document.getElementById("am-style-toggle-btn").addEventListener("click", () => {
      const next = state.settings.themeStyle === "spotify" ? "apple" : "spotify";
      state.settings.themeStyle = next;
      applySettings();
      if (api.storage && api.storage.local) {
        api.storage.local.set({ themeStyle: next });
      }
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

    document.getElementById("am-volume-slider").addEventListener("input", (e) => {
      const video = getVideo();
      if (video) {
        const val = Number(e.target.value) / 100;
        video.volume = val;
        video.muted = val === 0;
      }
    });

    document.getElementById("am-progress-bar").addEventListener("click", (e) => {
      const video = getVideo();
      if (!video || !Number.isFinite(video.duration)) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      video.currentTime = ratio * video.duration;
    });

    const scrollEl = document.getElementById("am-lyrics-scroll");
    scrollEl.addEventListener(
      "wheel",
      () => {
        state.userScrollingUntil = Date.now() + 4500;
      },
      { passive: true }
    );
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
    rightControls.prepend(btn);
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
      p.textContent = line.text;

      if (state.isSynced) {
        p.addEventListener("click", () => {
          const video = getVideo();
          if (video) {
            video.currentTime = Math.max(0, line.time - state.offsetSec);
            state.userScrollingUntil = 0;
          }
        });
      }
      container.appendChild(p);
    });
    state.activeIndex = -1;
  }

  async function loadLyricsForCurrentTrack() {
    const key = `${state.track.title}|||${state.track.artist}`;
    state.offsetSec = 0;
    const lbl = document.getElementById("am-offset-label");
    if (lbl) lbl.textContent = "Sync: 0.0s";

    renderLyricsLoading();

    try {
      const res = await new Promise((resolve) => {
        api.runtime.sendMessage(
          {
            type: "FETCH_LYRICS",
            payload: {
              title: state.track.title,
              artist: state.track.artist,
              album: state.track.album,
              duration: state.track.duration,
            },
          },
          (response) => resolve(response || { found: false })
        );
      });

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
      const volSlider = document.getElementById("am-volume-slider");

      if (fill && dur > 0) fill.style.width = `${(cur / dur) * 100}%`;
      if (curEl) curEl.textContent = formatTime(cur);
      if (durEl) durEl.textContent = formatTime(dur);
      if (artWrap) artWrap.classList.toggle("paused", video.paused);
      if (volSlider && document.activeElement !== volSlider) {
        volSlider.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
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
