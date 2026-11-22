const api = typeof browser !== "undefined" ? browser : chrome;

const checkboxIds = ["themeEnabled", "animateBg", "showLyricsBtn", "adblockEnabled"];
const styleSelect = document.getElementById("themeStyle");
const layoutSelect = document.getElementById("layoutMode");
const brandDot = document.getElementById("brandDot");
const syncNotice = document.getElementById("syncNotice");
const reloadTabBtn = document.getElementById("reloadTabBtn");

function syncAccent(style) {
  const color = style === "spotify" ? "#1db954" : "#fa2d48";
  if (brandDot) brandDot.style.background = color;
  document.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.style.accentColor = color;
  });
  if (reloadTabBtn) reloadTabBtn.style.background = color;
}

function showReloadNotice(show) {
  if (syncNotice) syncNotice.style.display = show ? "block" : "none";
}

// Push updated settings directly to all open YouTube Music tabs for instant application
function broadcastPatch(patch) {
  api.storage.local.set(patch);
  if (!api.tabs || !api.tabs.query) return;

  api.tabs.query({ url: "https://music.youtube.com/*" }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    let anyFailed = false;
    let pending = tabs.length;

    for (const tab of tabs) {
      api.tabs.sendMessage(tab.id, { type: "APPLY_SETTINGS", patch }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          anyFailed = true;
        }
        pending -= 1;
        if (pending === 0) {
          showReloadNotice(anyFailed);
        }
      });
    }
  });
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
    for (const id of checkboxIds) {
      const el = document.getElementById(id);
      if (el) el.checked = !!items[id];
    }
    if (styleSelect) {
      styleSelect.value = items.themeStyle || "apple";
      syncAccent(styleSelect.value);
    }
    if (layoutSelect) {
      layoutSelect.value = items.layoutMode || "desktop";
    }
  }
);

for (const id of checkboxIds) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener("change", () => {
    broadcastPatch({ [id]: el.checked });
  });
}

if (styleSelect) {
  styleSelect.addEventListener("change", () => {
    const val = styleSelect.value;
    syncAccent(val);
    broadcastPatch({ themeStyle: val });
  });
}

if (layoutSelect) {
  layoutSelect.addEventListener("change", () => {
    broadcastPatch({ layoutMode: layoutSelect.value });
  });
}

if (reloadTabBtn) {
  reloadTabBtn.addEventListener("click", () => {
    if (!api.tabs || !api.tabs.query) return;
    api.tabs.query({ url: "https://music.youtube.com/*" }, (tabs) => {
      for (const tab of tabs || []) {
        api.tabs.reload(tab.id);
      }
      showReloadNotice(false);
    });
  });
}
