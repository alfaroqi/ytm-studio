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
