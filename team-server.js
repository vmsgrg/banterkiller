// Simple in-memory game tracker for the Killer/Victim mode.
// Run with: `node team-server.js`
// Endpoints:
//   GET  /state              -> { counts, assignments, round }
//   POST /state              -> { assignments?, resetRound?, roundStartedAt? }
//   POST /assign             -> { userId, team }
// This is intentionally minimal and non-persistent.

const http = require("http");
const fs = require("fs");
const path = require("path");

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, "killer-state.json");
const GAME_DURATION_MS = Number(process.env.GAME_DURATION_MS) || 15 * 60 * 1000;
let persistPending = false;

const state = {
  assignments: {}, // userId -> "killer" | "victim"
  roundStartedAt: Date.now(),
};

function loadStateFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    if (data.assignments && typeof data.assignments === "object") state.assignments = data.assignments;
    if (Number.isFinite(data.roundStartedAt)) state.roundStartedAt = data.roundStartedAt;
    console.log(`[state] loaded from ${STATE_FILE}`);
  } catch (e) {
    console.warn(`[state] failed to load ${STATE_FILE}`, e);
  }
}

function persistStateToDisk() {
  if (persistPending) return;
  persistPending = true;
  setTimeout(() => {
    persistPending = false;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.warn(`[state] failed to persist to ${STATE_FILE}`, e);
    }
  }, 50);
}

function counts() {
  let killer = 0;
  let victim = 0;
  Object.values(state.assignments).forEach((t) => {
    if (t === "killer") killer += 1;
    if (t === "victim") victim += 1;
  });
  return { killer, victim };
}

function ensureActiveRound() {
  const now = Date.now();
  if (!state.roundStartedAt || now - state.roundStartedAt >= GAME_DURATION_MS) {
    state.roundStartedAt = now;
    state.assignments = {};
    persistStateToDisk();
    console.log("[state] round reset");
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/state") {
    ensureActiveRound();
    const round = {
      startedAt: state.roundStartedAt,
      durationMs: GAME_DURATION_MS,
      endsAt: state.roundStartedAt + GAME_DURATION_MS,
    };
    return send(res, 200, {
      counts: counts(),
      assignments: state.assignments,
      round,
    });
  }

  if (req.method === "POST" && req.url === "/state") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.connection.destroy();
    });
    req.on("end", () => {
      try {
        ensureActiveRound();
        const data = JSON.parse(raw || "{}");
        if (data.assignments && typeof data.assignments === "object") {
          Object.entries(data.assignments).forEach(([uid, team]) => {
            if (team === "killer" || team === "victim") {
              state.assignments[uid] = team;
            }
          });
        }
        if (data.resetRound === true) {
          state.assignments = {};
          state.roundStartedAt = Date.now();
        }
        if (Number.isFinite(data.roundStartedAt)) {
          state.roundStartedAt = data.roundStartedAt;
        }
        ensureActiveRound();
        persistStateToDisk();
        const round = {
          startedAt: state.roundStartedAt,
          durationMs: GAME_DURATION_MS,
          endsAt: state.roundStartedAt + GAME_DURATION_MS,
        };
        return send(res, 200, {
          ok: true,
          counts: counts(),
          assignments: state.assignments,
          round,
        });
      } catch (e) {
        return send(res, 400, { error: "bad json" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/assign") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.connection.destroy();
    });
    req.on("end", () => {
      try {
        ensureActiveRound();
        const data = JSON.parse(raw || "{}");
        const { userId, team } = data;
        if (!userId || (team !== "killer" && team !== "victim")) {
          return send(res, 400, { error: "invalid payload" });
        }
        state.assignments[userId] = team;
        persistStateToDisk();
        return send(res, 200, { ok: true, counts: counts(), assignments: state.assignments });
      } catch (e) {
        return send(res, 400, { error: "bad json" });
      }
    });
    return;
  }

  send(res, 404, { error: "not found" });
});

const PORT = process.env.PORT || 3000;
loadStateFromDisk();
server.listen(PORT, () => {
  console.log(`Team server listening on http://localhost:${PORT}`);
});
