const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const EXT_DIR = path.resolve(__dirname, "..");
const plain = (val) => JSON.parse(JSON.stringify(val));

function loadScriptInSandbox(filename, extraGlobals = {}) {
  const code = fs.readFileSync(path.join(EXT_DIR, filename), "utf8");
  const context = vm.createContext({
    console,
    URLSearchParams,
    Headers,
    Response,
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  });
  vm.runInContext(code, context, { filename });
  return context;
}

// ============================================================================
// 1. Manifest & Static Ruleset Validation
// ============================================================================

test("manifest.json is valid Chrome MV3 without Firefox-only keys", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")
  );
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal("scripts" in manifest.background, false);
  assert.equal("browser_specific_settings" in manifest, false);

  // Verify all referenced files exist on disk
  const filesToCheck = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.declarative_net_request.rule_resources.map((r) => r.path),
  ];
  for (const cs of manifest.content_scripts) {
    for (const f of cs.js || []) filesToCheck.push(f);
    for (const f of cs.css || []) filesToCheck.push(f);
  }
  for (const rel of filesToCheck) {
    assert.ok(
      fs.existsSync(path.join(EXT_DIR, rel)),
      `Referenced file missing: ${rel}`
    );
  }
});

test("rules/adblock.json has unique positive IDs and valid DNR actions", () => {
  const rules = JSON.parse(
    fs.readFileSync(path.join(EXT_DIR, "rules", "adblock.json"), "utf8")
  );
  assert.ok(Array.isArray(rules) && rules.length >= 5);
  const seenIds = new Set();
  for (const rule of rules) {
    assert.ok(Number.isInteger(rule.id) && rule.id > 0);
    assert.equal(seenIds.has(rule.id), false, `Duplicate rule id: ${rule.id}`);
    seenIds.add(rule.id);
    assert.equal(rule.action.type, "block");
    assert.ok(rule.condition && typeof rule.condition === "object");
  }
});

// ============================================================================
// 2. background.js — Title/Artist Cleaning, LRCLIB Fetch, & DNR Sync
// ============================================================================

test("background.js cleanTitle & cleanArtist normalize YouTube Music metadata", () => {
  const dnrCalls = [];
  const ctx = loadScriptInSandbox("background.js", {
    chrome: {
      runtime: { onMessage: { addListener: () => { } } },
      storage: {
        local: { get: (_d, cb) => cb({ adblockEnabled: true }) },
        onChanged: { addListener: () => { } },
      },
      declarativeNetRequest: {
        updateEnabledRulesets: (u) => {
          dnrCalls.push(u);
          return Promise.resolve();
        },
      },
    },
    fetch: async () => ({ ok: false }),
  });

  assert.equal(ctx.cleanTitle("Blinding Lights (Official Music Video)"), "Blinding Lights");
  assert.equal(ctx.cleanTitle("Starboy [Lyrics] (feat. Daft Punk)"), "Starboy");
  assert.equal(ctx.cleanTitle("Bohemian Rhapsody (Remastered 2011)"), "Bohemian Rhapsody");
  assert.equal(ctx.cleanArtist("The Weeknd - Topic"), "The Weeknd");
  assert.equal(ctx.cleanArtist("Daft Punk • Pharrell Williams"), "Daft Punk");
  assert.equal(ctx.cleanArtist("Coldplay & BTS"), "Coldplay");

  assert.deepEqual(plain(dnrCalls[0]), { enableRulesetIds: ["ytm_adblock"] });
  ctx.syncAdblockRuleset(false);
  assert.deepEqual(plain(dnrCalls[1]), { disableRulesetIds: ["ytm_adblock"] });
});

test("background.js fetchFromLrcLib returns exact match and falls back to best search match", async () => {
  let mode = "exact";
  const ctx = loadScriptInSandbox("background.js", {
    chrome: {
      runtime: { onMessage: { addListener: () => { } } },
      storage: { local: { get: () => { } }, onChanged: { addListener: () => { } } },
    },
    fetch: async (url) => {
      if (mode === "exact" && url.includes("/api/get")) {
        return {
          ok: true,
          json: async () => ({
            syncedLyrics: "[00:05.00]Hello world",
            trackName: "Hello",
            artistName: "Adele",
          }),
        };
      }
      if (mode === "search" && url.includes("/api/search")) {
        return {
          ok: true,
          json: async () => [
            { trackName: "Song", artistName: "Artist", duration: 300, plainLyrics: "Plain only" },
            { trackName: "Song", artistName: "Artist", duration: 201, syncedLyrics: "[00:01.00]Closest match" },
            { trackName: "Song", artistName: "Artist", duration: 120, syncedLyrics: "[00:01.00]Far duration" },
          ],
        };
      }
      return { ok: false, json: async () => null };
    },
  });

  const exactRes = await ctx.fetchFromLrcLib({ title: "Hello (Official Video)", artist: "Adele", duration: 295 });
  assert.equal(exactRes.found, true);
  assert.equal(exactRes.source, "lrclib-exact");
  assert.equal(exactRes.syncedLyrics, "[00:05.00]Hello world");

  mode = "search";
  const searchRes = await ctx.fetchFromLrcLib({ title: "Song", artist: "Artist", duration: 200 });
  assert.equal(searchRes.found, true);
  assert.equal(searchRes.source, "lrclib-search");
  assert.equal(searchRes.syncedLyrics, "[00:01.00]Closest match");
});

// ============================================================================
// 3. adblock-main.js — MAIN-World JSON Pruning
// ============================================================================

test("adblock-main.js prunes ad keys from /youtubei/v1/player responses and respects toggle", async () => {
  const docEl = { dataset: { amAdblock: "true" } };
  const fakeWindow = {
    fetch: async () =>
      new Response(
        JSON.stringify({
          videoDetails: { title: "Keep Me" },
          adPlacements: [{ id: 1 }],
          playerAds: [{ id: 2 }],
          adSlots: [{ id: 3 }],
          playerResponse: { adPlacements: [{ id: 4 }], streamingData: { ok: true } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  };

  loadScriptInSandbox("adblock-main.js", {
    window: fakeWindow,
    document: { documentElement: docEl },
  });

  // Enabled: ad keys must be stripped
  const res1 = await fakeWindow.fetch("https://music.youtube.com/youtubei/v1/player?prettyPrint=false");
  const body1 = await res1.json();
  assert.equal(body1.videoDetails.title, "Keep Me");
  assert.equal("adPlacements" in body1, false);
  assert.equal("playerAds" in body1, false);
  assert.equal("adSlots" in body1, false);
  assert.equal("adPlacements" in body1.playerResponse, false);
  assert.equal(body1.playerResponse.streamingData.ok, true);

  // Disabled: ad keys must remain untouched
  docEl.dataset.amAdblock = "false";
  const res2 = await fakeWindow.fetch("https://music.youtube.com/youtubei/v1/player?prettyPrint=false");
  const body2 = await res2.json();
  assert.ok(Array.isArray(body2.adPlacements));

  // ytInitialPlayerResponse setter pruning
  docEl.dataset.amAdblock = "true";
  fakeWindow.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [2], ok: true };
  assert.deepEqual(fakeWindow.ytInitialPlayerResponse, { ok: true });
});

test("adblock-main.js prunes ad keys from XMLHttpRequest /youtubei/v1/player responses", () => {
  const docEl = { dataset: { amAdblock: "true" } };
  class FakeXHR {
    open(method, url) {
      this._method = method;
      this._url = url;
    }
    get responseText() {
      return this._rawText;
    }
    get response() {
      return this._rawResponse;
    }
  }

  const fakeWindow = { XMLHttpRequest: FakeXHR };
  loadScriptInSandbox("adblock-main.js", {
    window: fakeWindow,
    document: { documentElement: docEl },
  });

  const xhr = new FakeXHR();
  xhr.open("POST", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
  xhr._rawText = JSON.stringify([
    {
      playerResponse: {
        videoDetails: { title: "YT Video" },
        adPlacements: [{ id: 1 }],
        playerAds: [{ id: 2 }],
        adSlots: [{ id: 3 }],
      },
    },
  ]);
  xhr._rawResponse = xhr._rawText;

  const parsed = JSON.parse(xhr.responseText);
  assert.equal(parsed[0].playerResponse.videoDetails.title, "YT Video");
  assert.equal("adPlacements" in parsed[0].playerResponse, false);
  assert.equal("playerAds" in parsed[0].playerResponse, false);
  assert.equal("adSlots" in parsed[0].playerResponse, false);

  // Disabled: response remains untouched
  docEl.dataset.amAdblock = "false";
  const unpruned = JSON.parse(xhr.responseText);
  assert.ok(Array.isArray(unpruned[0].playerResponse.adPlacements));
});

test("adblock-yt.js auto-skips ads on www.youtube.com SPA navigation and restores mute/speed", () => {
  const classes = new Set();
  const docEl = {
    dataset: {},
    classList: {
      toggle: (cls, force) => (force ? classes.add(cls) : classes.delete(cls)),
    },
  };
  const playerClasses = new Set(["ad-showing"]);
  const fakePlayer = {
    classList: { contains: (cls) => playerClasses.has(cls) },
  };
  let playCalls = 0;
  const fakeVideo = {
    muted: false,
    paused: true,
    duration: 30,
    currentTime: 0,
    playbackRate: 1,
    play: () => {
      playCalls++;
      return Promise.resolve();
    },
  };
  let skipClicks = 0;
  const fakeSkipBtn = { click: () => { skipClicks++; } };
  const winListeners = {};
  let msgListener = null;

  loadScriptInSandbox("adblock-yt.js", {
    window: {
      addEventListener: (type, fn) => {
        winListeners[type] = fn;
      },
    },
    document: {
      documentElement: docEl,
      querySelector: (sel) => {
        if (sel === "#movie_player") return fakePlayer;
        if (sel.includes("video")) return fakeVideo;
        if (sel === ".ytp-skip-ad-button") return fakeSkipBtn;
        return null;
      },
    },
    chrome: {
      runtime: {
        id: "test-ext",
        onMessage: { addListener: (fn) => { msgListener = fn; } },
      },
      storage: {
        local: { get: (_d, cb) => cb({ adblockEnabled: true }) },
        onChanged: { addListener: () => {} },
      },
    },
    setInterval: () => 1,
  });

  assert.equal(docEl.dataset.amAdblock, "true");
  assert.equal(classes.has("am-adblock-enabled"), true);
  assert.equal(fakeVideo.muted, true);
  assert.equal(fakeVideo.currentTime, 30);
  assert.equal(fakeVideo.playbackRate, 16);
  assert.equal(playCalls, 1);
  assert.equal(skipClicks, 1);

  // Ad finishes -> restores original mute state and playback rate
  playerClasses.delete("ad-showing");
  winListeners["yt-navigate-finish"]();
  assert.equal(fakeVideo.muted, false);
  assert.equal(fakeVideo.playbackRate, 1);

  // Popup toggle disables adblock cleanly
  msgListener({ type: "APPLY_SETTINGS", patch: { adblockEnabled: false } }, {}, () => {});
  assert.equal(docEl.dataset.amAdblock, "false");
  assert.equal(classes.has("am-adblock-enabled"), false);
});

test("adblock-main.js bridges am-set-volume events to #movie_player and YTM volume slider", () => {
  const listeners = {};
  const playerCalls = [];
  const sliderEvents = [];
  const fakePlayer = {
    setVolume: (v) => playerCalls.push(["setVolume", v]),
    mute: () => playerCalls.push(["mute"]),
    unMute: () => playerCalls.push(["unMute"]),
    seekTo: (t, allow) => playerCalls.push(["seekTo", t, allow]),
    pauseVideo: () => playerCalls.push(["pauseVideo"]),
    playVideo: () => playerCalls.push(["playVideo"]),
  };
  const fakeSlider = {
    value: 100,
    dispatchEvent: (ev) => sliderEvents.push(ev.type),
  };

  loadScriptInSandbox("adblock-main.js", {
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
    document: {
      documentElement: { dataset: { amAdblock: "true" } },
      querySelector: (sel) => (sel === "#movie_player" ? fakePlayer : null),
      querySelectorAll: (sel) => (sel.includes("#volume-slider") ? [fakeSlider] : []),
    },
    Event,
    CustomEvent,
  });

  assert.equal(typeof listeners["am-set-volume"], "function");

  listeners["am-set-volume"]({ detail: { volume: 42 } });
  assert.deepEqual(playerCalls, [["unMute"], ["setVolume", 42]]);
  assert.equal(fakeSlider.value, 42);
  assert.deepEqual(sliderEvents, ["change", "value-change"]);

  listeners["am-set-volume"]({ detail: { volume: 0 } });
  assert.deepEqual(playerCalls.slice(2), [["mute"], ["setVolume", 0]]);
  assert.equal(fakeSlider.value, 0);

  listeners["am-seek-to"]({ detail: { time: 75.5 } });
  assert.deepEqual(playerCalls.slice(4), [["seekTo", 75.5, true]]);

  listeners["am-set-playback"]({ detail: { action: "pause" } });
  listeners["am-set-playback"]({ detail: { action: "play" } });
  assert.deepEqual(playerCalls.slice(5), [["pauseVideo"], ["playVideo"]]);
});

test("adblock-main.js bridges am-get-track from MediaSession and #movie_player.getVideoData", () => {
  const listeners = {};
  const dispatched = [];
  let mediaMeta = {
    title: "Track From MediaSession",
    artist: "MS Artist",
    album: "MS Album",
    artwork: [{ src: "https://example.com/small.jpg" }, { src: "https://example.com/large.jpg" }],
  };
  const fakePlayer = {
    getVideoData: () => ({
      title: "Track From Player",
      author: "Player Artist",
      video_id: "n1udh_flRQU",
    }),
  };

  loadScriptInSandbox("adblock-main.js", {
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      dispatchEvent: (ev) => {
        dispatched.push(ev);
      },
    },
    navigator: {
      mediaSession: {
        get metadata() {
          return mediaMeta;
        },
      },
    },
    document: {
      documentElement: { dataset: { amAdblock: "true" } },
      querySelector: (sel) => (sel === "#movie_player" ? fakePlayer : null),
      querySelectorAll: () => [],
    },
    Event,
    CustomEvent,
  });

  // 1. MediaSession metadata takes priority
  listeners["am-get-track"]();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, "am-track-info");
  assert.deepEqual(JSON.parse(dispatched[0].detail), {
    title: "Track From MediaSession",
    artist: "MS Artist",
    album: "MS Album",
    artwork: "https://example.com/large.jpg",
  });

  // 2. Falls back to #movie_player.getVideoData when MediaSession is unavailable
  mediaMeta = null;
  listeners["am-get-track"]();
  assert.equal(dispatched.length, 2);
  assert.deepEqual(JSON.parse(dispatched[1].detail), {
    title: "Track From Player",
    artist: "Player Artist",
    album: "",
    artwork: "https://i.ytimg.com/vi/n1udh_flRQU/hqdefault.jpg",
  });
});

test("content.js readCurrentTrack falls back to broader DOM, MediaSession, and MAIN-world bridge", () => {
  const src = fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8");
  const upgradeMatch = src.match(/function upgradeArtworkUrl[\s\S]*?\n  \}/);
  const videoMatch = src.match(/function getVideo[\s\S]*?\n  \}/);
  const readMatch = src.match(/function readMainWorldTrack[\s\S]*?return \{ title, artist, album, artwork, duration \};\s*\}/);
  assert.ok(upgradeMatch && videoMatch && readMatch, "Could not locate readCurrentTrack helpers");

  const code = `${upgradeMatch[0]}\n${videoMatch[0]}\n${readMatch[0]}`;

  // Case 1: Altered player bar DOM (e.g. A/B test or another extension changed class names)
  const alteredBar = {
    querySelector: (sel) => {
      if (sel === "yt-formatted-string.title") return { textContent: "Night Dancer" };
      if (sel === ".content-info-wrapper .subtitle") return { textContent: "imase • 2022" };
      if (sel === ".thumbnail-image-wrapper img") {
        return { src: "https://lh3.googleusercontent.com/x=w60-h60-l90-rj" };
      }
      return null;
    },
  };
  const ctx1 = vm.createContext({
    document: {
      querySelector: (sel) =>
        sel === "ytmusic-player-bar" ? alteredBar : sel.includes("video") ? { duration: 210 } : null,
    },
    navigator: {},
    window: { addEventListener: () => { }, removeEventListener: () => { }, dispatchEvent: () => { } },
    CustomEvent,
  });
  vm.runInContext(code, ctx1);
  assert.deepEqual(plain(ctx1.readCurrentTrack()), {
    title: "Night Dancer",
    artist: "imase",
    album: "",
    artwork: "https://lh3.googleusercontent.com/x=w600-h600-l90-rj",
    duration: 210,
  });

  // Case 2: Player bar missing/empty -> falls back to MAIN-world bridge
  const listeners = {};
  const ctx2 = vm.createContext({
    document: {
      querySelector: (sel) => (sel.includes("video") ? { duration: 185 } : null),
    },
    navigator: {},
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      removeEventListener: (type) => {
        delete listeners[type];
      },
      dispatchEvent: (ev) => {
        if (ev.type === "am-get-track" && listeners["am-track-info"]) {
          listeners["am-track-info"]({
            detail: JSON.stringify({
              title: "Fallback Song",
              artist: "Fallback Artist",
              album: "Fallback Album",
              artwork: "https://i.ytimg.com/vi/n1udh_flRQU/hqdefault.jpg",
            }),
          });
        }
      },
    },
    CustomEvent,
  });
  vm.runInContext(code, ctx2);
  assert.deepEqual(plain(ctx2.readCurrentTrack()), {
    title: "Fallback Song",
    artist: "Fallback Artist",
    album: "Fallback Album",
    artwork: "https://i.ytimg.com/vi/n1udh_flRQU/hqdefault.jpg",
    duration: 185,
  });
});

// ============================================================================
// 4. content.js — LRC Parser, Time Formatting, & Artwork Upgrading
// ============================================================================

test("content.js parses synced LRC, multi-timestamps, enhanced word tags, and upgrades artwork", () => {
  // Extract pure helper functions from content.js into an isolated VM context
  const src = fs.readFileSync(path.join(EXT_DIR, "content.js"), "utf8");
  const fnMatch = src.match(/function formatTime[\s\S]*?return result;\s*\}/);
  assert.ok(fnMatch, "Could not locate helper functions in content.js");

  const ctx = vm.createContext({});
  vm.runInContext(fnMatch[0], ctx);

  // formatTime
  assert.equal(ctx.formatTime(0), "0:00");
  assert.equal(ctx.formatTime(65), "1:05");
  assert.equal(ctx.formatTime(125.9), "2:05");
  assert.equal(ctx.formatTime(-10), "0:00");
  assert.equal(ctx.formatTime(NaN), "0:00");

  // upgradeArtworkUrl
  assert.equal(
    ctx.upgradeArtworkUrl("https://lh3.googleusercontent.com/abc=w60-h60-l90-rj"),
    "https://lh3.googleusercontent.com/abc=w600-h600-l90-rj"
  );

  // parseLrc: standard, multi-timestamp, enhanced word tags, empty line, out-of-order sorting
  const lrc = [
    "[00:12.50]Second line",
    "[00:04.25][01:00.00]<00:04.25>First <00:05.00>chorus",
    "[00:08.00]   ",
  ].join("\n");

  const parsed = plain(ctx.parseLrc(lrc));
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], { time: 4.25, text: "First chorus" });
  assert.deepEqual(parsed[1], { time: 8.0, text: "♪" });
  assert.deepEqual(parsed[2], { time: 12.5, text: "Second line" });
  assert.deepEqual(parsed[3], { time: 60.0, text: "First chorus" });
});

// ============================================================================
// 5. background.js — CJK Detection, Local Romanizers, & Online Batch Romanize
// ============================================================================

test("background.js detects JP/KR/CN languages and romanizes Kana & Hangul locally", () => {
  const ctx = loadScriptInSandbox("background.js", {
    chrome: {
      runtime: { onMessage: { addListener: () => { } } },
      storage: { local: { get: () => { } }, onChanged: { addListener: () => { } } },
    },
    fetch: async () => ({ ok: false }),
  });

  // Language detection
  assert.equal(ctx.detectCjkLanguage(["Hello world", "Sing along"]), null);
  assert.equal(ctx.detectCjkLanguage(["夜に駆ける", "沈むように"]), "ja");
  assert.equal(ctx.detectCjkLanguage(["사랑해", "너를 좋아해"]), "ko");
  assert.equal(ctx.detectCjkLanguage(["月亮代表我的心", "你问我爱你有多深"]), "zh-CN");

  // Local Hangul romanization (including liaison before ㅇ)
  assert.equal(ctx.romanizeHangulLocal("사랑해"), "saranghae");
  assert.equal(ctx.romanizeHangulLocal("한국어"), "hangugeo");

  // Local Kana Hepburn romanization (hiragana, katakana, digraphs, sokuon, chouonpu)
  assert.equal(ctx.romanizeKanaLocal("ありがとう"), "arigatou");
  assert.equal(ctx.romanizeKanaLocal("カフェ"), "kafe");
  assert.equal(ctx.romanizeKanaLocal("きゃっ"), "kya");
  assert.equal(ctx.romanizeKanaLocal("きっと"), "kitto");
  assert.equal(ctx.romanizeKanaLocal("ラーメン"), "raamen");
});

test("background.js romanizeLines batches online requests, skips English, deduplicates, and falls back offline", async () => {
  let fetchCalls = 0;
  let online = true;
  const ctx = loadScriptInSandbox("background.js", {
    chrome: {
      runtime: { onMessage: { addListener: () => { } } },
      storage: { local: { get: () => { } }, onChanged: { addListener: () => { } } },
    },
    fetch: async (url) => {
      fetchCalls++;
      if (!online) throw new Error("network down");
      assert.ok(url.includes("translate.googleapis.com/translate_a/single"));
      assert.ok(url.includes("dt=rm"));
      const rawQ = new URL(url).searchParams.get("q") || "";
      const map = {
        "夜に駆ける": "Yoru ni kakeru",
        "沈むように": "Shizumu you ni",
        "月亮代表我的心": "Yuèliàng dàibiǎo wǒ de xīn",
      };
      const out = rawQ
        .split("\n")
        .map((line) => map[line] || line)
        .join("\n");
      return {
        ok: true,
        json: async () => [[[null, null, null, out]]],
      };
    },
  });

  // Japanese song with repeated chorus + English line
  const jpRes = plain(
    await ctx.romanizeLines(["夜に駆ける", "Let's go", "沈むように", "夜に駆ける"])
  );
  assert.equal(jpRes.language, "ja");
  assert.deepEqual(jpRes.romaji, ["Yoru ni kakeru", "", "Shizumu you ni", "Yoru ni kakeru"]);
  assert.equal(fetchCalls, 1);

  // Cached lines should not trigger another fetch
  const jpCached = plain(await ctx.romanizeLines(["夜に駆ける"]));
  assert.deepEqual(jpCached.romaji, ["Yoru ni kakeru"]);
  assert.equal(fetchCalls, 1);

  // Chinese song -> Pinyin
  const cnRes = plain(await ctx.romanizeLines(["月亮代表我的心"]));
  assert.equal(cnRes.language, "zh-CN");
  assert.deepEqual(cnRes.romaji, ["Yuèliàng dàibiǎo wǒ de xīn"]);

  // Offline fallback for Korean Hangul
  online = false;
  const koOffline = plain(await ctx.romanizeLines(["사랑해", "Baby"]));
  assert.equal(koOffline.language, "ko");
  assert.deepEqual(koOffline.romaji, ["saranghae", ""]);
});

test("background.js translateLines batches English translations, deduplicates, caches, and skips unchanged lines", async () => {
  let fetchCalls = 0;
  const ctx = loadScriptInSandbox("background.js", {
    chrome: {
      runtime: { onMessage: { addListener: () => { } } },
      storage: { local: { get: () => { } }, onChanged: { addListener: () => { } } },
    },
    fetch: async (url) => {
      fetchCalls++;
      assert.ok(url.includes("translate.googleapis.com/translate_a/single"));
      assert.ok(url.includes("dt=t"));
      const rawQ = new URL(url).searchParams.get("q") || "";
      const map = {
        "夜に駆ける": "Racing into the Night",
        "사랑해": "I love you",
        "Hello": "Hello",
      };
      const segments = rawQ.split("\n").map((line, i, arr) => [
        (map[line] || line) + (i < arr.length - 1 ? "\n" : ""),
        line,
      ]);
      return {
        ok: true,
        json: async () => [segments],
      };
    },
  });

  const res = plain(
    await ctx.translateLines(["夜に駆ける", "♪", "Hello", "사랑해", "夜に駆ける"], "en")
  );
  assert.equal(res.targetLang, "en");
  assert.deepEqual(res.translations, [
    "Racing into the Night",
    "",
    "",
    "I love you",
    "Racing into the Night",
  ]);
  assert.equal(fetchCalls, 1);

  // Cached lines should not trigger another fetch
  const cached = plain(await ctx.translateLines(["사랑해"], "en"));
  assert.deepEqual(cached.translations, ["I love you"]);
  assert.equal(fetchCalls, 1);
});
