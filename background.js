// Cross-browser API shim (Chrome & Firefox)
const api = typeof browser !== "undefined" ? browser : chrome;

// Clean YouTube Music track titles (remove "(Official Video)", "[Lyrics]", "feat. ...", etc.)
function cleanTitle(raw) {
  if (!raw) return "";
  return raw
    .replace(/\s*[\(\[](?:official\s*(?:music\s*)?video|official\s*audio|lyric\s*video|lyrics|hd|4k|mv|m\/v|audio|visualizer|remastered(?:\s*\d+)?|live.*?)[\)\]]/gi, "")
    .replace(/\s*[\(\[]feat\.?[^\)\]]*[\)\]]/gi, "")
    .replace(/\s+feat\.?\s+.*$/i, "")
    .replace(/\s+ft\.?\s+.*$/i, "")
    .trim();
}

function cleanArtist(raw) {
  if (!raw) return "";
  // Take primary artist if separated by •, &, ,, or x
  return raw
    .split(/[•·,&]|(?:\s+x\s+)|(?:\s+feat\.?\s+)|(?:\s+ft\.?\s+)/i)[0]
    .replace(/\s*-\s*Topic$/i, "")
    .trim();
}

async function fetchFromLrcLib({ title, artist, album, duration }) {
  const cleanedTitle = cleanTitle(title);
  const cleanedArtist = cleanArtist(artist);

  // 1. Exact match endpoint (/api/get)
  if (cleanedTitle && cleanedArtist) {
    const params = new URLSearchParams({
      track_name: cleanedTitle,
      artist_name: cleanedArtist,
    });
    if (album) params.set("album_name", album);
    if (duration && Number.isFinite(duration) && duration > 0) {
      params.set("duration", String(Math.round(duration)));
    }

    try {
      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: { "User-Agent": "YTM-AppleMusic-Ext/1.0.0" },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.syncedLyrics || data.plainLyrics)) {
          return {
            found: true,
            syncedLyrics: data.syncedLyrics || "",
            plainLyrics: data.plainLyrics || "",
            trackName: data.trackName || cleanedTitle,
            artistName: data.artistName || cleanedArtist,
            source: "lrclib-exact",
          };
        }
      }
    } catch (_) {
      // Fallback to search below
    }
  }

  // 2. Search endpoint (/api/search) — pick best synced match by duration proximity
  const queries = [];
  if (cleanedTitle && cleanedArtist) {
    queries.push(`track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(cleanedArtist)}`);
    queries.push(`q=${encodeURIComponent(`${cleanedArtist} ${cleanedTitle}`)}`);
  } else if (cleanedTitle) {
    queries.push(`q=${encodeURIComponent(cleanedTitle)}`);
  }

  for (const qs of queries) {
    try {
      const res = await fetch(`https://lrclib.net/api/search?${qs}`, {
        headers: { "User-Agent": "YTM-AppleMusic-Ext/1.0.0" },
      });
      if (!res.ok) continue;
      const list = await res.json();
      if (!Array.isArray(list) || list.length === 0) continue;

      // Prefer entries with syncedLyrics and closest duration
      const scored = list
        .filter((item) => item.syncedLyrics || item.plainLyrics)
        .map((item) => {
          let score = item.syncedLyrics ? 100 : 10;
          if (duration && item.duration) {
            const diff = Math.abs(item.duration - duration);
            score -= Math.min(diff, 60);
          }
          return { item, score };
        })
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        const best = scored[0].item;
        return {
          found: true,
          syncedLyrics: best.syncedLyrics || "",
          plainLyrics: best.plainLyrics || "",
          trackName: best.trackName || cleanedTitle,
          artistName: best.artistName || cleanedArtist,
          source: "lrclib-search",
        };
      }
    } catch (_) {
      // Try next query
    }
  }

  return { found: false, syncedLyrics: "", plainLyrics: "", source: "none" };
}

// ============================================================================
// CJK Romanization (Japanese Romaji, Korean Romanization, Chinese Pinyin)
// ============================================================================

const CJK_REGEX =
  /[\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF]/;
const KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/g;
const HANGUL_REGEX = /[\uAC00-\uD7AF]/g;
const HAN_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;

function hasCjk(text) {
  return typeof text === "string" && CJK_REGEX.test(text);
}

function detectCjkLanguage(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const joined = lines.join("\n");
  if (!CJK_REGEX.test(joined)) return null;

  const kanaCount = (joined.match(KANA_REGEX) || []).length;
  const hangulCount = (joined.match(HANGUL_REGEX) || []).length;
  const hanCount = (joined.match(HAN_REGEX) || []).length;

  if (hangulCount > 0 && hangulCount >= kanaCount && hangulCount >= hanCount) {
    return "ko";
  }
  if (kanaCount > 0) return "ja";
  if (hanCount > 0) return "zh-CN";
  return null;
}

function detectLineLanguage(line, defaultLang) {
  const hasHangul = /[\uAC00-\uD7AF]/.test(line);
  const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(line);
  if (hasHangul && !hasKana) return "ko";
  if (hasKana) return "ja";
  return defaultLang;
}

// Local algorithmic Revised Romanization of Korean (offline fallback)
const KO_INITIALS = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s",
  "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];
const KO_MEDIALS = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa",
  "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
];
const KO_FINALS = [
  "", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "p", "l", "t",
  "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t",
];
const KO_LIAISON_FINALS = [
  "", "g", "kk", "gs", "n", "nj", "nh", "d", "r", "lg", "lm", "lb", "ls", "lt",
  "lp", "lh", "m", "b", "bs", "s", "ss", "ng", "j", "ch", "k", "t", "p", "h",
];

function romanizeHangulLocal(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const init = Math.floor(idx / 588);
      const med = Math.floor((idx % 588) / 28);
      const fin = idx % 28;
      let finStr = KO_FINALS[fin];
      // Basic liaison when followed by vowel-initial syllable (ㅇ)
      if (fin !== 0 && i + 1 < text.length) {
        const nextCode = text.charCodeAt(i + 1);
        if (nextCode >= 0xac00 && nextCode <= 0xd7a3) {
          const nextInit = Math.floor((nextCode - 0xac00) / 588);
          if (nextInit === 11) {
            finStr = KO_LIAISON_FINALS[fin];
          }
        }
      }
      out += KO_INITIALS[init] + KO_MEDIALS[med] + finStr;
    } else {
      out += text[i];
    }
  }
  return out;
}

// Local Hepburn romanizer for Japanese Hiragana & Katakana (offline fallback)
const KANA_DIGRAPHS = {
  きゃ: "kya", きゅ: "kyu", きょ: "kyo",
  しゃ: "sha", しゅ: "shu", しょ: "sho",
  ちゃ: "cha", ちゅ: "chu", ちょ: "cho",
  にゃ: "nya", にゅ: "nyu", にょ: "nyo",
  ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo",
  みゃ: "mya", みゅ: "myu", みょ: "myo",
  りゃ: "rya", りゅ: "ryu", りょ: "ryo",
  ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
  じゃ: "ja",  じゅ: "ju",  じょ: "jo",
  びゃ: "bya", びゅ: "byu", びょ: "byo",
  ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo",
  ふぁ: "fa",  ふぃ: "fi",  ふぇ: "fe",  ふぉ: "fo",
  てぃ: "ti",  でぃ: "di",  うぃ: "wi",  うぇ: "we",
  ゔぁ: "va",  ゔぃ: "vi",  ゔぇ: "ve",  ゔぉ: "vo",
};

const KANA_SINGLE = {
  あ: "a", い: "i", う: "u", え: "e", お: "o",
  か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no",
  は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo",
  や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro",
  わ: "wa", ゐ: "wi", ゑ: "we", を: "wo", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go",
  ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po",
  ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
  ゃ: "ya", ゅ: "yu", ょ: "yo", ゔ: "vu",
};

function toHiragana(text) {
  let res = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x30a1 && code <= 0x30f6) {
      res += String.fromCharCode(code - 0x60);
    } else {
      res += text[i];
    }
  }
  return res;
}

function romanizeKanaLocal(text) {
  const hira = toHiragana(text);
  let out = "";
  for (let i = 0; i < hira.length; i++) {
    const ch = hira[i];
    if (ch === "っ") {
      // Sokuon: geminate next consonant
      const nextPair = hira.slice(i + 1, i + 3);
      const nextRom = KANA_DIGRAPHS[nextPair] || KANA_SINGLE[hira[i + 1]] || "";
      if (nextRom) {
        out += nextRom.startsWith("ch") ? "t" : nextRom[0];
      }
      continue;
    }
    if (ch === "ー") {
      const m = out.match(/[aeiou]$/);
      if (m) out += m[0];
      continue;
    }
    const pair = hira.slice(i, i + 2);
    if (KANA_DIGRAPHS[pair]) {
      out += KANA_DIGRAPHS[pair];
      i++;
      continue;
    }
    if (KANA_SINGLE[ch]) {
      out += KANA_SINGLE[ch];
      continue;
    }
    out += ch;
  }
  return out;
}

function romanizeLocalFallback(text, lang) {
  if (!text) return "";
  let converted = text;
  if (lang === "ko") {
    converted = romanizeHangulLocal(text);
  } else if (lang === "ja") {
    converted = romanizeKanaLocal(text);
  }
  // Only return if something actually changed
  return converted !== text ? converted : "";
}

const romajiCache = new Map();
const ROMAJI_CACHE_MAX = 800;

function setRomajiCache(key, value) {
  if (romajiCache.size >= ROMAJI_CACHE_MAX) {
    const firstKey = romajiCache.keys().next().value;
    romajiCache.delete(firstKey);
  }
  romajiCache.set(key, value);
}

async function fetchRomanizationBatch(lines, lang) {
  const joined = lines.join("\n");
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
    lang
  )}&tl=en&dt=rm&q=${encodeURIComponent(joined)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;

  let fullRomaji = "";
  for (const seg of data[0]) {
    if (Array.isArray(seg) && typeof seg[3] === "string") {
      fullRomaji += seg[3];
    }
  }
  if (!fullRomaji) return null;

  if (lines.length === 1) {
    return [fullRomaji.replace(/\r?\n/g, " ").trim()];
  }

  const parts = fullRomaji.split(/\r?\n/);
  if (parts.length !== lines.length) return null;
  return parts.map((p) => p.trim());
}

async function romanizeLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { language: null, romaji: [] };
  }

  const defaultLang = detectCjkLanguage(lines);
  if (!defaultLang) {
    return { language: null, romaji: lines.map(() => "") };
  }

  // Group unique CJK lines by detected language to minimize requests
  const uncachedByLang = new Map();
  const lineMeta = lines.map((line) => {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed || !hasCjk(trimmed)) {
      return { skip: true, text: trimmed, lang: null };
    }
    const lang = detectLineLanguage(trimmed, defaultLang);
    const cacheKey = `${lang}:${trimmed}`;
    if (!romajiCache.has(cacheKey)) {
      if (!uncachedByLang.has(lang)) uncachedByLang.set(lang, new Set());
      uncachedByLang.get(lang).add(trimmed);
    }
    return { skip: false, text: trimmed, lang, cacheKey };
  });

  // Fetch uncached unique lines in small GET batches per language
  for (const [lang, uniqueSet] of uncachedByLang.entries()) {
    const uniqueList = Array.from(uniqueSet);
    const BATCH_MAX_LINES = 12;
    const BATCH_MAX_CHARS = 450;

    let idx = 0;
    while (idx < uniqueList.length) {
      const batch = [];
      let charCount = 0;
      while (
        idx < uniqueList.length &&
        batch.length < BATCH_MAX_LINES &&
        (batch.length === 0 || charCount + uniqueList[idx].length <= BATCH_MAX_CHARS)
      ) {
        batch.push(uniqueList[idx]);
        charCount += uniqueList[idx].length + 1;
        idx++;
      }

      let batchResult = null;
      let networkFailed = false;
      try {
        batchResult = await fetchRomanizationBatch(batch, lang);
      } catch (_) {
        networkFailed = true;
      }

      // If Google merged/split newlines in a multi-line batch, retry per-line so Kanji still gets romanized
      if (!batchResult && !networkFailed && batch.length > 1) {
        batchResult = new Array(batch.length).fill("");
        const CONCURRENCY = 4;
        for (let j = 0; j < batch.length; j += CONCURRENCY) {
          const slice = batch.slice(j, j + CONCURRENCY);
          const results = await Promise.all(
            slice.map((line) =>
              fetchRomanizationBatch([line], lang)
                .then((r) => (r && r[0]) || "")
                .catch(() => "")
            )
          );
          for (let k = 0; k < results.length; k++) {
            batchResult[j + k] = results[k];
          }
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const src = batch[i];
        let rom = batchResult && batchResult[i] ? batchResult[i] : "";
        if (!rom || rom === src) {
          rom = romanizeLocalFallback(src, lang);
        }
        setRomajiCache(`${lang}:${src}`, rom);
      }
    }
  }

  const romaji = lineMeta.map((meta) => {
    if (meta.skip) return "";
    const cached = romajiCache.get(meta.cacheKey) || "";
    return cached && cached !== meta.text ? cached : "";
  });

  return { language: defaultLang, romaji };
}

// ============================================================================
// Lyrics Translation (English)
// ============================================================================

const translateCache = new Map();
const TRANSLATE_CACHE_MAX = 800;

function setTranslateCache(key, value) {
  if (translateCache.size >= TRANSLATE_CACHE_MAX) {
    const firstKey = translateCache.keys().next().value;
    translateCache.delete(firstKey);
  }
  translateCache.set(key, value);
}

async function fetchTranslationBatch(lines, targetLang = "en") {
  const joined = lines.join("\n");
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
    targetLang
  )}&dt=t&q=${encodeURIComponent(joined)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;

  let fullTranslated = "";
  for (const seg of data[0]) {
    if (Array.isArray(seg) && typeof seg[0] === "string") {
      fullTranslated += seg[0];
    }
  }
  if (!fullTranslated) return null;

  if (lines.length === 1) {
    return [fullTranslated.replace(/\r?\n/g, " ").trim()];
  }

  const parts = fullTranslated.split(/\r?\n/);
  if (parts.length !== lines.length) return null;
  return parts.map((p) => p.trim());
}

async function translateLines(lines, targetLang = "en") {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { targetLang, translations: [] };
  }

  const uncached = new Set();
  const lineMeta = lines.map((line) => {
    const trimmed = typeof line === "string" ? line.trim() : "";
    if (!trimmed || trimmed === "♪") {
      return { skip: true, text: trimmed };
    }
    const cacheKey = `${targetLang}:${trimmed}`;
    if (!translateCache.has(cacheKey)) {
      uncached.add(trimmed);
    }
    return { skip: false, text: trimmed, cacheKey };
  });

  const uniqueList = Array.from(uncached);
  const BATCH_MAX_LINES = 12;
  const BATCH_MAX_CHARS = 450;

  let idx = 0;
  while (idx < uniqueList.length) {
    const batch = [];
    let charCount = 0;
    while (
      idx < uniqueList.length &&
      batch.length < BATCH_MAX_LINES &&
      (batch.length === 0 || charCount + uniqueList[idx].length <= BATCH_MAX_CHARS)
    ) {
      batch.push(uniqueList[idx]);
      charCount += uniqueList[idx].length + 1;
      idx++;
    }

    let batchResult = null;
    let networkFailed = false;
    try {
      batchResult = await fetchTranslationBatch(batch, targetLang);
    } catch (_) {
      networkFailed = true;
    }

    if (!batchResult && !networkFailed && batch.length > 1) {
      batchResult = new Array(batch.length).fill("");
      const CONCURRENCY = 4;
      for (let j = 0; j < batch.length; j += CONCURRENCY) {
        const slice = batch.slice(j, j + CONCURRENCY);
        const results = await Promise.all(
          slice.map((line) =>
            fetchTranslationBatch([line], targetLang)
              .then((r) => (r && r[0]) || "")
              .catch(() => "")
          )
        );
        for (let k = 0; k < results.length; k++) {
          batchResult[j + k] = results[k];
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const src = batch[i];
      const translated = batchResult && batchResult[i] ? batchResult[i] : "";
      const cleaned =
        translated && translated.toLowerCase() !== src.toLowerCase() ? translated : "";
      setTranslateCache(`${targetLang}:${src}`, cleaned);
    }
  }

  const translations = lineMeta.map((meta) => {
    if (meta.skip) return "";
    return translateCache.get(meta.cacheKey) || "";
  });

  return { targetLang, translations };
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "FETCH_LYRICS") {
    fetchFromLrcLib(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          found: false,
          error: String(err),
          syncedLyrics: "",
          plainLyrics: "",
        })
      );
    return true; // keep message channel open for async response
  }

  if (message && message.type === "ROMANIZE_LYRICS") {
    const lines = (message.payload && message.payload.lines) || [];
    romanizeLines(lines)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          language: null,
          romaji: [],
          error: String(err),
        })
      );
    return true;
  }

  if (message && message.type === "TRANSLATE_LYRICS") {
    const lines = (message.payload && message.payload.lines) || [];
    const targetLang = (message.payload && message.payload.targetLang) || "en";
    translateLines(lines, targetLang)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          targetLang,
          translations: [],
          error: String(err),
        })
      );
    return true;
  }
});

// Sync declarativeNetRequest static ruleset with the user's adblock toggle
function syncAdblockRuleset(enabled) {
  if (!api.declarativeNetRequest || !api.declarativeNetRequest.updateEnabledRulesets) {
    return;
  }
  const update = enabled
    ? { enableRulesetIds: ["ytm_adblock"] }
    : { disableRulesetIds: ["ytm_adblock"] };
  api.declarativeNetRequest.updateEnabledRulesets(update).catch(() => {});
}

if (api.storage && api.storage.local) {
  api.storage.local.get({ adblockEnabled: true }, (items) => {
    syncAdblockRuleset(!!items.adblockEnabled);
  });
}

if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes) => {
    if (changes.adblockEnabled) {
      syncAdblockRuleset(!!changes.adblockEnabled.newValue);
    }
  });
}
