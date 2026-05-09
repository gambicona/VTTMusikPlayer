const express = require("express");
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024 * 1024
});

const PORT = 3001;
const DATA_DIR = path.join(__dirname, "data");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");

const ALL_VIEW_ID = "__ALL__";
const DEFAULT_PLAYLIST_ID = "__UNSORTIERT__";
const OTHER_IMPORTS_ID = "__OTHER_IMPORTS__";

let state = null;

let playbackState = {
  player: "main",
  videoId: null,
  queue: [],
  index: -1,
  playing: false,
  positionSec: 0,
  updatedAt: Date.now()
};

function freshState() {
  return {
    tracks: {},
    playlists: [],
    folders: [],
    ui: {
      selectedPlaylistId: ALL_VIEW_ID,
      selectedFolderId: "__ALL__",
      loopSelections: {},
      shuffleEnabled: false
    }
  };
}

function makeId(prefix = "id") {
  if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function ensureDefaultPlaylist(s) {
  if (!Array.isArray(s.playlists)) s.playlists = [];

  if (!s.playlists.some(p => p.id === DEFAULT_PLAYLIST_ID)) {
    s.playlists.unshift({
      id: DEFAULT_PLAYLIST_ID,
      name: "Unsortiert",
      trackIds: [],
      folderIds: []
    });
  }
}

function ensureOtherImportsPlaylist(s) {
  if (!Array.isArray(s.playlists)) s.playlists = [];

  let pl = s.playlists.find(p => p.id === OTHER_IMPORTS_ID);

  if (!pl) {
    pl = {
      id: OTHER_IMPORTS_ID,
      name: "OtherImports",
      trackIds: [],
      folderIds: [],
      source: { type: "guestImports" }
    };

    s.playlists.push(pl);
  }

  if (!Array.isArray(pl.trackIds)) pl.trackIds = [];
  if (!Array.isArray(pl.folderIds)) pl.folderIds = [];

  return pl;
}

function normalizeState(s) {
  if (!s || typeof s !== "object") s = freshState();

  s.tracks = s.tracks && typeof s.tracks === "object" ? s.tracks : {};
  s.playlists = Array.isArray(s.playlists) ? s.playlists : [];
  s.folders = Array.isArray(s.folders) ? s.folders : [];
  s.ui = s.ui && typeof s.ui === "object" ? s.ui : {};

  if (!s.ui.selectedPlaylistId) s.ui.selectedPlaylistId = ALL_VIEW_ID;
  if (!s.ui.selectedFolderId) s.ui.selectedFolderId = "__ALL__";
  if (!s.ui.loopSelections) s.ui.loopSelections = {};
  if (typeof s.ui.shuffleEnabled !== "boolean") s.ui.shuffleEnabled = false;

  for (const pl of s.playlists) {
    if (!Array.isArray(pl.trackIds)) pl.trackIds = [];
    if (!Array.isArray(pl.folderIds)) pl.folderIds = [];
  }

  ensureDefaultPlaylist(s);
  ensureOtherImportsPlaylist(s);

  return s;
}

async function loadState() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(LIBRARY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    state = normalizeState(parsed.state || parsed);
  } catch {
    state = normalizeState(freshState());
    await saveState();
  }
}

async function saveState() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const payload = {
    version: 6,
    savedAt: new Date().toISOString(),
    state
  };

  await fs.writeFile(LIBRARY_FILE, JSON.stringify(payload, null, 2), "utf8");
}

function mediaExtFromType(type, originalName = "") {
  const fromName = path.extname(String(originalName || "")).toLowerCase();
  if ([".mp3", ".mp4", ".wav"].includes(fromName)) return fromName;
  if (type === "audio/mpeg") return ".mp3";
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return ".wav";
  if (type === "video/mp4") return ".mp4";
  return "";
}

function isAllowedMediaType(type, ext) {
  return ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "video/mp4"].includes(type)
    || [".mp3", ".mp4", ".wav"].includes(ext);
}

function safeMediaSegment(value, fallback = "Lokale Medien") {
  const cleaned = String(value || "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 120);

  return cleaned || fallback;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueMediaPath(dir, originalName, ext) {
  const parsed = path.parse(originalName || `local-media${ext}`);
  const base = safeMediaSegment(parsed.name, "local-media");
  const finalExt = ext || parsed.ext || "";

  for (let i = 1; i < 10000; i++) {
    const suffix = i === 1 ? "" : ` (${i})`;
    const filename = `${base}${suffix}${finalExt}`;
    const filePath = path.join(dir, filename);
    if (!await fileExists(filePath)) return { filename, filePath };
  }

  const fallback = `${base}-${Date.now()}${finalExt}`;
  return { filename: fallback, filePath: path.join(dir, fallback) };
}

function mediaUrlFromParts(...parts) {
  return "/media/" + parts.map(part => encodeURIComponent(part).replace(/%2F/gi, "/")).join("/");
}

async function matchingExistingMediaPath(dir, originalName, ext, size) {
  const parsed = path.parse(originalName || `local-media${ext}`);
  const filename = `${safeMediaSegment(parsed.name, "local-media")}${ext || parsed.ext || ""}`;
  const filePath = path.join(dir, filename);

  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile() && stat.size === size) {
      return { filename, filePath };
    }
  } catch {}

  return null;
}

function findLocalTrackByMediaUrl(mediaUrl) {
  for (const track of Object.values(state?.tracks || {})) {
    if (track?.mediaUrl === mediaUrl && (track.source === "local" || track.source === "localCut")) {
      return track;
    }
  }
  return null;
}

function extractVideoId(url) {
  if (!url) return null;
  url = String(url).trim();

  try {
    const u = new URL(url);

    if (u.hostname.includes("youtu.be")) {
      const id = u.pathname.replace("/", "").trim();
      return id || null;
    }

    const v = u.searchParams.get("v");
    if (v) return v.trim();

    const shortsMatch = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{6,})/);
    if (shortsMatch) return shortsMatch[1];

    const embedMatch = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{6,})/);
    if (embedMatch) return embedMatch[1];

    return null;
  } catch {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{6,})/);
    return m ? m[1] : null;
  }
}

function makeThumbUrl(videoId) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function textFromRuns(node) {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || "").join("");
  return "";
}

function findJsonObjectAfterKey(text, key) {
  let keyIndex = text.indexOf(`"${key}"`);
  if (keyIndex < 0) keyIndex = text.indexOf(key);
  if (keyIndex < 0) return null;
  const start = text.indexOf("{", keyIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }

    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function parseTimestampToSec(raw) {
  const parts = String(raw).split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function parseChaptersFromDescription(description) {
  const chapters = [];
  const seen = new Set();
  const lines = String(description || "").split(/\r?\n/);
  const timestampRe = /(?:^|\s)(\d{1,2}:\d{2}(?::\d{2})?)(?:\s|$|[-–—|:])/;

  for (const line of lines) {
    const match = line.match(timestampRe);
    if (!match) continue;
    const startSec = parseTimestampToSec(match[1]);
    if (!Number.isFinite(startSec) || seen.has(startSec)) continue;

    let title = line.replace(match[1], "").replace(/^[-–—|:\s]+/, "").trim();
    if (!title) title = `Kapitel ${chapters.length + 1}`;
    chapters.push({ title, startSec });
    seen.add(startSec);
  }

  return chapters.sort((a, b) => a.startSec - b.startSec);
}

function collectChapterRenderers(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.chapterRenderer) out.push(node.chapterRenderer);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectChapterRenderers(value, out);
  }
  return out;
}

async function fetchOEmbed(url) {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("format", "json");

  const res = await fetch(endpoint.toString());

  if (!res.ok) {
    throw new Error("oEmbed failed");
  }

  return await res.json();
}

app.get("/api/oembed", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    if (!url) {
      res.status(400).json({ error: "Missing url" });
      return;
    }

    const data = await fetchOEmbed(url);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message || "oEmbed failed" });
  }
});

app.get("/api/youtube-chapters", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    const videoId = extractVideoId(url);
    if (!videoId) {
      res.status(400).json({ error: "Missing or invalid YouTube video URL" });
      return;
    }

    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const [oembedResult, pageResult] = await Promise.allSettled([
      fetchOEmbed(watchUrl),
      fetch(watchUrl, {
        headers: {
          "user-agent": "Mozilla/5.0",
          "accept-language": "en-US,en;q=0.9"
        }
      })
    ]);

    const meta = oembedResult.status === "fulfilled" ? oembedResult.value : {};
    if (pageResult.status !== "fulfilled" || !pageResult.value.ok) {
      res.status(502).json({ error: "Could not load YouTube watch page" });
      return;
    }

    const html = await pageResult.value.text();
    let chapters = [];
    let durationSec = 0;

    const playerRaw = findJsonObjectAfterKey(html, "ytInitialPlayerResponse");
    if (playerRaw) {
      try {
        const playerData = JSON.parse(playerRaw);
        durationSec = Number(playerData?.videoDetails?.lengthSeconds || 0);
        const shortDescription = playerData?.videoDetails?.shortDescription || "";
        chapters = parseChaptersFromDescription(shortDescription);
      } catch {}
    }

    const initialRaw = findJsonObjectAfterKey(html, "ytInitialData");
    if (initialRaw) {
      try {
        const initialData = JSON.parse(initialRaw);
        const renderers = collectChapterRenderers(initialData);
        const parsed = renderers
          .map(r => ({
            title: textFromRuns(r.title).trim(),
            startSec: Math.floor(Number(r.timeRangeStartMillis || 0) / 1000)
          }))
          .filter(ch => ch.title && Number.isFinite(ch.startSec));
        if (parsed.length >= 2) {
          const unique = new Map();
          for (const ch of parsed) unique.set(ch.startSec, ch);
          chapters = Array.from(unique.values()).sort((a, b) => a.startSec - b.startSec);
        }
      } catch {}
    }

    if (chapters.length < 2) {
      res.status(404).json({ error: "No YouTube chapters or timestamp list found" });
      return;
    }

    res.json({
      videoId,
      title: meta.title || "",
      thumbnailUrl: meta.thumbnail_url || makeThumbUrl(videoId),
      durationSec,
      chapters
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "Chapter import failed" });
  }
});

app.post("/api/local-media", express.raw({
  type: ["audio/*", "video/*", "application/octet-stream"],
  limit: "750mb"
}), async (req, res) => {
  try {
    const originalName = decodeURIComponent(String(req.header("x-file-name") || "local-media")).trim();
    const mediaFolderName = decodeURIComponent(String(req.header("x-media-folder") || "Lokale Medien")).trim();
    const mediaType = String(req.header("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const ext = mediaExtFromType(mediaType, originalName);

    if (!isAllowedMediaType(mediaType, ext)) {
      res.status(415).json({ error: "Only MP3, MP4 and WAV files are supported." });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "No media data received." });
      return;
    }

    const folderName = safeMediaSegment(mediaFolderName);
    const targetDir = path.join(MEDIA_DIR, folderName);
    await fs.mkdir(targetDir, { recursive: true });

    let existingFile = await matchingExistingMediaPath(targetDir, originalName, ext, req.body.length);
    let filename;
    let filePath;

    if (existingFile) {
      ({ filename, filePath } = existingFile);
    } else {
      ({ filename, filePath } = await uniqueMediaPath(targetDir, originalName, ext));
      await fs.writeFile(filePath, req.body);
    }

    const mediaUrl = mediaUrlFromParts(folderName, filename);
    const existingTrack = findLocalTrackByMediaUrl(mediaUrl);
    const id = existingTrack?.videoId || existingTrack?.id || `local_${crypto.randomUUID()}`;

    res.json({
      ok: true,
      reusedFile: !!existingFile,
      reusedTrack: !!existingTrack,
      track: {
        ...(existingTrack || {}),
        id,
        videoId: id,
        source: existingTrack?.source || "local",
        mediaUrl,
        mediaType,
        originalFilename: originalName,
        mediaFolder: folderName,
        storedFilename: filename,
        originalTitle: existingTrack?.originalTitle || path.basename(originalName, ext) || originalName || "Lokale Datei",
        durationSec: existingTrack?.durationSec || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Local media upload failed" });
  }
});

async function guestImportUrl(url) {
  const videoId = extractVideoId(url);

  if (!videoId) {
    throw new Error("Could not read a YouTube video ID from this URL.");
  }

  let originalTitle = "(Titel nicht verfügbar)";
  let thumbnailUrl = makeThumbUrl(videoId);

  try {
    const o = await fetchOEmbed(url);
    if (o?.title) originalTitle = o.title;
    if (o?.thumbnail_url) thumbnailUrl = o.thumbnail_url;
  } catch {
    // fallback is fine
  }

  const existing = state.tracks[videoId];

  state.tracks[videoId] = {
    ...(existing || {}),
    videoId,
    source: "youtube",
    url,
    originalTitle: existing?.originalTitle || originalTitle,
    thumbnailUrl: existing?.thumbnailUrl || thumbnailUrl,
    durationSec: existing?.durationSec || 0,
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now()
  };

  const other = ensureOtherImportsPlaylist(state);

  if (!other.trackIds.includes(videoId)) {
    other.trackIds.push(videoId);
  }

  await saveState();

  return {
    videoId,
    playlistId: OTHER_IMPORTS_ID,
    queue: [...other.trackIds]
  };
}

app.use("/media", express.static(MEDIA_DIR));
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  const role = socket.handshake.auth?.role === "host" ? "host" : "guest";
  socket.data.role = role;
  console.log(`Connected [${role}]:`, socket.id);

  socket.emit("library:state", state);
  socket.emit("playback:state", playbackState);

  socket.on("library:replace", async (nextState, ack) => {
    try {
      state = normalizeState(nextState);
      await saveState();

      socket.broadcast.emit("library:state", state);
      ack?.({ ok: true });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on("library:guestImportUrl", async ({ url, playNow } = {}, ack) => {
    try {
      const result = await guestImportUrl(url);

      io.emit("library:state", state);

      if (playNow) {
        playbackState = {
          player: "main",
          videoId: result.videoId,
          queue: result.queue,
          index: result.queue.indexOf(result.videoId),
          playing: true,
          positionSec: 0,
          updatedAt: Date.now()
        };

        io.emit("playback:command", {
          type: "playTrack",
          ...playbackState
        });
      }

      ack?.({ ok: true, ...result });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on("playback:command", (cmd = {}) => {
    playbackState = {
      ...playbackState,
      ...cmd,
      updatedAt: Date.now()
    };

    socket.broadcast.emit("playback:command", {
      ...cmd,
      updatedAt: playbackState.updatedAt
    });
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected [${socket.data.role || "guest"}]:`, socket.id);
  });
});

loadState().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Music app running at http://localhost:${PORT}`);
  });
});
