import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ZOOM_LEVELS,
  addInstrumentationInitScript,
  applyZoom,
  buildScenario,
  lastInput,
  markInput,
  printSummary,
  readCounters,
  readGpuRenderer,
  round,
  runCtrlWheelZoom,
  runKeyZoom,
  runSpaceDrag,
  runWheelPan,
  skippedScenario,
  startRecording,
  stopRecording,
  summarizeBlocking,
  waitForQuiet,
  waitForSettled,
  waitForSharp,
  writeResult,
} from "../../helpers/perf-metrics";

// Real-file benchmark: same S1-S4 scenarios as perf-navigation.spec.js, plus a
// cold open, page switches (S6) and editing scenarios on one board (S7-S9).
// No RPC mocks: it talks to a real backend.
//
// Env vars:
//   PENPOT_PERF_REAL=1            required, otherwise the describe is skipped
//   PENPOT_PERF_BASE_URL          default http://localhost:3450
//   PENPOT_BENCH_CREDENTIALS      path to JSON {"email", "password"}
//   PENPOT_BENCH_FILE_INFO        path to JSON written by the generator
//   PENPOT_PERF_OUT               output dir (see writeResult)
//   PENPOT_PERF_GROUPS            comma list of nav, pages, edit, theme (default nav,pages,edit)

const DEFAULT_BASE_URL = "http://localhost:3450";
const BASE_URL = (
  process.env.PENPOT_PERF_BASE_URL || DEFAULT_BASE_URL
).replace(/\/+$/, "");

// nav = S1-S4, pages = S6, edit = S7-S9, theme = T1-T3 (not in the default).
const GROUPS = new Set(
  (process.env.PENPOT_PERF_GROUPS || "nav,pages,edit")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean),
);

const PAGE_LOAD_TIMEOUT_MS = 120000;
const FIRST_TILES_TIMEOUT_MS = 5 * 60 * 1000;
const PAGE_SWITCH_TIMEOUT_MS = 60000;
const SELECT_TIMEOUT_MS = 3000;
const UNDO_POLL_MS = 600;
const STEP_MS = 16;
const BOARD_DRAG_STEPS = 60;
const BOARD_DRAG_DX = 400;
const BOARD_DRAG_DY = 200;
const NUDGE_COUNT = 20;
const NUDGE_GAP_MS = 60;

// About 45%, same as the "~45%" level in ZOOM_LEVELS.
const EDIT_ZOOM_KEYS = ["Shift+0", "-", "-", "-"];

const S7_NAMES = ["S7 drag board @ ~45%", "S7 undo drag"];
const S8_NAMES = ["S8 nudge x20 @ ~45%", "S8 undo nudges"];
const S9_NAMES = ["S9 opacity 5", "S9 opacity 0", "S9 undo opacity"];

// Theme group (T1-T3): switch the active token theme, then visit another page.
const THEME_SWITCHES = [["Light", "Dark"], ["Dark", "Mid"], ["Mid", "Light"]];
const THEME_TIMEOUT_MS = 10 * 60 * 1000;
const THEME_QUIET_MS = 1000;
const STABLE_SHOT_MS = 5000;
const THEME_SELECT_TIMEOUT_MS = 15000;
const THEME_CLIP_PX = 160;
const OTHER_CLIP_PX = 240;
const OTHER_POLL_MS = 150;
const OTHER_WAIT_MS = 60000;
const SAVE_WAIT_MS = 5 * 60 * 1000;
const SAVE_START_WAIT_MS = 15000;
const SAVE_POLL_MS = 250;
const SAVE_QUIET_MS = 3500;

function readJsonFromEnv(name, description) {
  const file = process.env[name];
  if (!file) {
    throw new Error(`${name} is not set; it must point to ${description}`);
  }
  return JSON.parse(readFileSync(path.resolve(file), "utf8"));
}

function readCredentials() {
  const credentials = readJsonFromEnv(
    "PENPOT_BENCH_CREDENTIALS",
    'a JSON file with "email" and "password"',
  );
  if (!credentials.email || !credentials.password) {
    throw new Error(
      'PENPOT_BENCH_CREDENTIALS must contain "email" and "password"',
    );
  }
  return credentials;
}

function readFileInfo() {
  const fileInfo = readJsonFromEnv(
    "PENPOT_BENCH_FILE_INFO",
    "the file-info JSON written by frontend/scripts/perf/generate-large-design.mjs",
  );
  if (!fileInfo.fileId || !fileInfo.teamId || !Array.isArray(fileInfo.pages)) {
    throw new Error(
      "PENPOT_BENCH_FILE_INFO must contain fileId, teamId and pages",
    );
  }
  return fileInfo;
}

/**
 * Logs in through the API. The auth cookie lands in the context cookie jar,
 * which page.request shares with the page. The response body is not read.
 */
async function login(page, { email, password }) {
  const response = await page.request.post(
    `${BASE_URL}/api/main/methods/login-with-password`,
    {
      headers: {
        "content-type": "application/transit+json",
        accept: "application/transit+json",
      },
      data: JSON.stringify(["^ ", "~:email", email, "~:password", password]),
    },
  );
  if (!response.ok()) {
    throw new Error(
      `login-with-password failed with HTTP ${response.status()}`,
    );
  }
}

/**
 * Init scripts run in the page before app code, so no tiles-complete or
 * set-objects event is missed. The first one records the cold-open timing.
 * The second records each set-objects event (page id and time) for S6.
 */
async function addInitScripts(page) {
  await addInstrumentationInitScript(page);
  await page.addInitScript(() => {
    document.addEventListener("penpot:wasm:tiles-complete", () => {
      if (window.__perfFirstTilesComplete === undefined) {
        window.__perfFirstTilesComplete = {
          at: performance.now(),
          wall: Date.now(),
        };
      }
    });
    window.__perfSetObjects = [];
    document.addEventListener("penpot:wasm:set-objects", (event) => {
      const pageId = event.detail?.pageId;
      window.__perfSetObjects.push({
        at: performance.now(),
        pageId: pageId === undefined || pageId === null ? null : String(pageId),
      });
    });
  });
}

/**
 * Picks the cold-open page: the first "Screens" page, else the second page.
 */
function pickColdPage(pages) {
  const screens = pages.find((page) => /^Screens/.test(page.name));
  if (!screens && pages.length < 2) {
    throw new Error(
      "the file needs at least two pages, or a page named Screens*",
    );
  }
  return screens ?? pages[1];
}

async function coldOpen(page, { teamId, fileId, cold }) {
  const url =
    `${BASE_URL}/?screen=workspace` +
    `&team-id=${encodeURIComponent(teamId)}` +
    `&file-id=${encodeURIComponent(fileId)}` +
    `&page-id=${encodeURIComponent(cold.id)}`;

  const gotoWall = Date.now();
  await page.goto(url);

  // page-name matches every sidebar page entry when the page list is open,
  // so take the first one: strict mode would reject the plain locator.
  await expect(page.getByTestId("page-name").first()).toBeVisible({
    timeout: PAGE_LOAD_TIMEOUT_MS,
  });

  try {
    await page
      .getByTestId("canvas-wasm-shapes")
      .waitFor({ state: "attached", timeout: PAGE_LOAD_TIMEOUT_MS });
  } catch (_error) {
    throw new Error(
      "canvas-wasm-shapes is missing: the backend may not have the " +
        "render-wasm flags on (enable-feature-render-wasm, " +
        "enable-render-wasm-dpr)",
    );
  }

  await page.waitForFunction(
    () => window.__perfFirstTilesComplete !== undefined,
    null,
    { timeout: FIRST_TILES_TIMEOUT_MS },
  );
  const first = await page.evaluate(() => window.__perfFirstTilesComplete);

  const result = {
    pageId: cold.id,
    pageName: cold.name,
    firstTilesCompleteMs: round(first.at),
    wallFromGotoMs: round(first.wall - gotoWall),
    usedJSHeapSize: await page.evaluate(
      () => performance.memory?.usedJSHeapSize ?? null,
    ),
  };
  console.log(
    `cold open: first tiles ${result.firstTilesCompleteMs} ms ` +
      `(from navigation start), ${result.wallFromGotoMs} ms (wall clock)`,
  );
  return result;
}

/**
 * Waits for the first penpot:wasm:set-objects event for page `pageId` at or
 * after `sinceMs` (page clock). Returns its page-clock time, or null if none
 * arrives within PAGE_SWITCH_TIMEOUT_MS.
 */
async function waitForShapesReady(page, pageId, sinceMs) {
  try {
    await page.waitForFunction(
      (args) => {
        // Upstream builds fire the event without a page id; accept those.
        const found = window.__perfSetObjects.find(
          (e) =>
            (e.pageId === args.id || e.pageId === null) && e.at >= args.since,
        );
        return found !== undefined;
      },
      { id: pageId, since: sinceMs },
      { timeout: PAGE_SWITCH_TIMEOUT_MS, polling: 50 },
    );
  } catch (_error) {
    return null;
  }
  return page.evaluate(
    (args) =>
      window.__perfSetObjects.find(
        (e) =>
          (e.pageId === args.id || e.pageId === null) && e.at >= args.since,
      ).at,
    { id: pageId, since: sinceMs },
  );
}

/**
 * Time from the click `t0` to the first tiles-complete at or after the
 * shapes were ready at `shapesAt`. Null if shapesAt is null or no
 * tiles-complete arrives within the waitForSharp timeout.
 */
async function waitForSharpAfterShapes(page, t0, shapesAt) {
  if (shapesAt === null) {
    return null;
  }
  const delay = await waitForSharp(page, shapesAt);
  return delay === null ? null : round(shapesAt - t0 + delay);
}

/** Switches the page from the sidebar and times the switch to sharp. */
async function switchPage(page, from, to) {
  const item = page.locator(`[data-testid="page-${to.id}"]`);
  await expect(item).toBeVisible();

  await startRecording(page);
  const t0 = await markInput(page);
  await item.getByTestId("page-name").click();
  await page.waitForURL(
    (url) => new URL(url).searchParams.get("page-id") === to.id,
    { timeout: PAGE_SWITCH_TIMEOUT_MS },
  );

  const shapesAt = await waitForShapesReady(page, to.id, t0);
  const timeToSharpMs = await waitForSharpAfterShapes(page, t0, shapesAt);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  return {
    ...buildScenario({
      name: `S6 page ${from.name} -> ${to.name}`,
      zoom: null,
      raw,
      timeToSharpMs,
      counters,
    }),
    from: from.name,
    to: to.name,
    toPageId: to.id,
    shapesReadyMs: shapesAt === null ? null : round(shapesAt - t0),
  };
}

/**
 * Finds the root board whose title is fully inside the viewport and nearest
 * its centre. Returns { id, x, y } (label centre), or null.
 */
async function findBoardNearCentre(page, workspace) {
  const box = await workspace.viewport.boundingBox();
  if (!box) {
    return null;
  }
  return page.evaluate((view) => {
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const group of document.querySelectorAll(
      'g.frame-title[id^="frame-title-"]',
    )) {
      const label = group.querySelector("foreignObject > div");
      if (!label) {
        continue;
      }
      const rect = label.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) {
        continue;
      }
      const inside =
        rect.left >= view.x &&
        rect.top >= view.y &&
        rect.right <= view.x + view.width &&
        rect.bottom <= view.y + view.height;
      if (!inside) {
        continue;
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { id: group.id.slice("frame-title-".length), x, y };
      }
    }
    return best;
  }, box);
}

/** Label rect of a root board title, or null if it is not rendered. */
async function titleRect(page, id) {
  return page.evaluate((frameId) => {
    const group = document.getElementById("frame-title-" + frameId);
    const label = group?.querySelector("foreignObject > div");
    if (!label) {
      return null;
    }
    const rect = label.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, id);
}

/** True when the rect sits fully inside the viewport box. */
function rectInside(rect, box) {
  return (
    rect !== null &&
    box !== null &&
    rect.x >= box.x &&
    rect.y >= box.y &&
    rect.x + rect.width <= box.x + box.width &&
    rect.y + rect.height <= box.y + box.height
  );
}

/** True when a shape is selected (resize handles are shown). */
async function isSelected(page) {
  return page.evaluate(
    () =>
      document.querySelector('[data-testid^="resize-side-handler-"]') !== null,
  );
}

/** Best effort: the opacity text in the layer menu, or null. */
async function readOpacity(page) {
  try {
    const text = await page.evaluate(() => {
      const section = document.querySelector(
        'section[aria-label="Layer menu section"]',
      );
      const input = section?.querySelector("input");
      return input ? input.value : null;
    });
    const value = text === null ? "" : String(text).trim();
    return value === "" ? null : value;
  } catch (_error) {
    return null;
  }
}

/** Polls an async node-side predicate every 50 ms. True if it holds in time. */
async function waitUntil(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      return false;
    }
    await page.waitForTimeout(50);
  }
  return true;
}

/** True when both rects exist and their x and y differ by at most tol. */
function samePos(a, b, tol = 1.5) {
  if (!a || !b) {
    return false;
  }
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

/**
 * Presses undo until isRestored() holds, at most maxPresses times. Waits up
 * to pollMs after each press for the result to show.
 */
async function undoUntil(
  page,
  isRestored,
  { maxPresses, pollMs = UNDO_POLL_MS },
) {
  let presses = 0;
  while (presses < maxPresses && !(await isRestored())) {
    await page.keyboard.press("ControlOrMeta+z");
    presses++;
    await waitUntil(page, isRestored, pollMs);
  }
  return { presses, restored: await isRestored() };
}

/** Move in screen px between two title rects, or null. */
function movedBy(before, after) {
  if (!before || !after) {
    return null;
  }
  return { dx: round(after.x - before.x), dy: round(after.y - before.y) };
}

/** Real click on a board title label: move, press, release. */
async function clickTitle(page, x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/**
 * Selects one root board by clicking its title, then zooms to about 45% with
 * the title still visible. Returns { ok, id } or { ok: false, reason }.
 */
async function selectBoard(page, workspace) {
  try {
    await applyZoom(page, workspace, ["Shift+1"]);
    const target = await findBoardNearCentre(page, workspace);
    if (!target) {
      return { ok: false, reason: "no board title visible at fit zoom" };
    }
    await clickTitle(page, target.x, target.y);
    if (!(await waitUntil(page, () => isSelected(page), SELECT_TIMEOUT_MS))) {
      return { ok: false, reason: "click on board title did not select it" };
    }
    await applyZoom(page, workspace, ["Shift+2"]);
    await applyZoom(page, workspace, EDIT_ZOOM_KEYS);
    const rect = await titleRect(page, target.id);
    const box = await workspace.viewport.boundingBox();
    if (!(await isSelected(page)) || !rectInside(rect, box)) {
      return { ok: false, reason: "board title not visible at ~45% zoom" };
    }
    return { ok: true, id: target.id };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/** Clicks the board title again if the selection was lost. */
async function ensureSelected(page, workspace, boardId) {
  try {
    if (await isSelected(page)) {
      return true;
    }
    const rect = await titleRect(page, boardId);
    const box = await workspace.viewport.boundingBox();
    if (!rectInside(rect, box)) {
      return false;
    }
    await clickTitle(page, rect.x + rect.width / 2, rect.y + rect.height / 2);
    return await waitUntil(page, () => isSelected(page), SELECT_TIMEOUT_MS);
  } catch (_error) {
    return false;
  }
}

/** S7: drags the selected board, then undoes the move. */
async function runBoardDrag(page, boardId) {
  const before = await titleRect(page, boardId);
  if (!before) {
    return [skippedScenario(S7_NAMES[0], "board title missing")];
  }
  const start = {
    x: before.x + before.width / 2,
    y: before.y + before.height / 2,
  };
  await page.mouse.move(start.x, start.y);
  await page.waitForTimeout(200);

  await startRecording(page);
  await page.mouse.down();
  for (let step = 1; step <= BOARD_DRAG_STEPS; step++) {
    await page.mouse.move(
      start.x + (BOARD_DRAG_DX * step) / BOARD_DRAG_STEPS,
      start.y + (BOARD_DRAG_DY * step) / BOARD_DRAG_STEPS,
    );
    await page.waitForTimeout(STEP_MS);
  }
  await page.mouse.up();
  const inputAt = await lastInput(page);

  const timeToSharpMs = await waitForSharp(page, inputAt);
  const settledMs = await waitForSettled(page, inputAt);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  const after = await titleRect(page, boardId);
  const drag = buildScenario({
    name: S7_NAMES[0],
    zoom: "~45%",
    raw,
    timeToSharpMs,
    counters,
    settledMs,
    extra: { boardId, moved: movedBy(before, after) },
  });

  // Undo the move. Press again only if the board is not back yet.
  await page.waitForTimeout(300);
  await startRecording(page);
  const t0 = await markInput(page);
  await page.keyboard.press("ControlOrMeta+z");
  const undoSharpMs = await waitForSharp(page, t0);
  const undoSettledMs = await waitForSettled(page, t0);
  const undoRaw = await stopRecording(page);
  const undoCounters = await readCounters(page);

  let extraUndoPresses = 0;
  if (!samePos(await titleRect(page, boardId), before)) {
    const extra = await undoUntil(
      page,
      async () => samePos(await titleRect(page, boardId), before),
      { maxPresses: 3, pollMs: UNDO_POLL_MS },
    );
    extraUndoPresses = extra.presses;
  }
  const undo = buildScenario({
    name: S7_NAMES[1],
    zoom: "~45%",
    raw: undoRaw,
    timeToSharpMs: undoSharpMs,
    counters: undoCounters,
    settledMs: undoSettledMs,
    extra: {
      boardId,
      restored: samePos(await titleRect(page, boardId), before),
      extraUndoPresses,
    },
  });
  return [drag, undo];
}

/** S8: nudges the selected board with ArrowRight, then undoes the nudges. */
async function runNudges(page, boardId) {
  const before = await titleRect(page, boardId);
  if (!before) {
    return S8_NAMES.map((name) =>
      skippedScenario(name, "board title missing"),
    );
  }

  await startRecording(page);
  let lastPressAt = null;
  for (let i = 0; i < NUDGE_COUNT; i++) {
    lastPressAt = await markInput(page);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(NUDGE_GAP_MS);
  }
  const timeToSharpMs = await waitForSharp(page, lastPressAt);
  // Penpot merges quick nudges and commits about 250 ms after the last key-up.
  const settledMs = await waitForSettled(page, lastPressAt, { quietMs: 800 });
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  const after = await titleRect(page, boardId);
  const nudge = buildScenario({
    name: S8_NAMES[0],
    zoom: "~45%",
    raw,
    timeToSharpMs,
    counters,
    settledMs,
    extra: { boardId, moved: movedBy(before, after) },
  });

  await startRecording(page);
  const t0 = await markInput(page);
  const { presses, restored } = await undoUntil(
    page,
    async () => samePos(await titleRect(page, boardId), before),
    { maxPresses: NUDGE_COUNT, pollMs: UNDO_POLL_MS },
  );
  const undoSharpMs = await waitForSharp(page, t0);
  const undoSettledMs = await waitForSettled(page, t0);
  const undoRaw = await stopRecording(page);
  const undoCounters = await readCounters(page);
  const undo = buildScenario({
    name: S8_NAMES[1],
    zoom: "~45%",
    raw: undoRaw,
    timeToSharpMs: undoSharpMs,
    counters: undoCounters,
    settledMs: undoSettledMs,
    extra: { boardId, undoPresses: presses, restored },
  });
  return [nudge, undo];
}

/** S9: sets opacity to 5 then 0 on the selection, then undoes both. */
async function runOpacityEdit(page, boardId) {
  const original = await readOpacity(page);
  const results = [];

  for (const key of ["5", "0"]) {
    await startRecording(page);
    const t0 = await markInput(page);
    await page.keyboard.press(key);
    const timeToSharpMs = await waitForSharp(page, t0);
    // Penpot emits a second opacity event about 600 ms later. Keep recording.
    await page.waitForTimeout(1000);
    const settledMs = await waitForSettled(page, t0);
    const raw = await stopRecording(page);
    const counters = await readCounters(page);
    results.push(
      buildScenario({
        name: `S9 opacity ${key}`,
        zoom: "~45%",
        raw,
        timeToSharpMs,
        counters,
        settledMs,
        extra: { boardId, opacityAfter: await readOpacity(page) },
      }),
    );
  }

  // Undo both edits, timed from the first undo press.
  await startRecording(page);
  const t0 = await markInput(page);
  let undoPresses = 0;
  if (original !== null) {
    const toFifty = await undoUntil(
      page,
      async () => (await readOpacity(page)) === "50",
      { maxPresses: 3, pollMs: UNDO_POLL_MS },
    );
    const toOriginal = await undoUntil(
      page,
      async () => (await readOpacity(page)) === original,
      { maxPresses: 3, pollMs: UNDO_POLL_MS },
    );
    undoPresses = toFifty.presses + toOriginal.presses;
  } else {
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(600);
    await page.keyboard.press("ControlOrMeta+z");
    undoPresses = 2;
  }
  const undoSharpMs = await waitForSharp(page, t0);
  const undoSettledMs = await waitForSettled(page, t0);
  const undoRaw = await stopRecording(page);
  const undoCounters = await readCounters(page);
  const opacityFinal = await readOpacity(page);
  results.push(
    buildScenario({
      name: S9_NAMES[2],
      zoom: "~45%",
      raw: undoRaw,
      timeToSharpMs: undoSharpMs,
      counters: undoCounters,
      settledMs: undoSettledMs,
      extra: {
        boardId,
        undoPresses,
        opacityOriginal: original,
        opacityFinal,
        restored: original === null ? null : opacityFinal === original,
      },
    }),
  );
  return results;
}

const BASE_SCENARIO_KEYS = new Set([
  "name",
  "zoom",
  "frames",
  "longTasks",
  "timeToSharpMs",
  "settledMs",
  "counters",
]);

/** Logs one editing result so a person can follow the run. */
function logEdit(scenario) {
  if (scenario.skipped) {
    console.log(`edit: ${scenario.name} skipped: ${scenario.reason}`);
    return;
  }
  const extra = Object.fromEntries(
    Object.entries(scenario).filter(([key]) => !BASE_SCENARIO_KEYS.has(key)),
  );
  console.log(
    `edit: ${scenario.name}: sharp ${scenario.timeToSharpMs} ms, ` +
      `settled ${scenario.settledMs} ms, ${JSON.stringify(extra)}`,
  );
}

/** Records skipped scenarios for a step that did not run. */
function skipEdit(names, reason) {
  const results = names.map((name) => skippedScenario(name, reason));
  results.forEach(logEdit);
  return results;
}

/** Runs one editing step. An error skips its scenarios; the test goes on. */
async function runEditStep(names, run) {
  let results;
  try {
    results = await run();
  } catch (error) {
    results = skipEdit(names, `error: ${String(error)}`);
    return results;
  }
  results.forEach(logEdit);
  return results;
}

/**
 * Tracks save requests (update-file) on the page. Call before the cold open.
 * Times use the node clock (Date.now()).
 */
function trackSaves(page) {
  const saves = {
    inFlight: new Set(),
    lastStartAt: null,
    lastDoneAt: null,
    startedTimes: [],
  };
  const isSave = (request) =>
    request.url().includes("/api/main/methods/update-file");
  page.on("request", (request) => {
    if (!isSave(request)) {
      return;
    }
    const now = Date.now();
    saves.inFlight.add(request);
    saves.lastStartAt = now;
    saves.startedTimes.push(now);
  });
  const finish = (request) => {
    if (!isSave(request)) {
      return;
    }
    saves.inFlight.delete(request);
    saves.lastDoneAt = Date.now();
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  return saves;
}

/**
 * Waits for a save started at or after sinceWall to end: none in flight and
 * none finished for 3.5 s. Returns the time from sinceWall to the last finish,
 * or null if no save starts within 15 s or the wait passes SAVE_WAIT_MS.
 */
async function waitForSave(page, saves, sinceWall) {
  const callAt = Date.now();
  for (;;) {
    const now = Date.now();
    const started = saves.startedTimes.some((t) => t >= sinceWall);
    if (!started && now - callAt >= SAVE_START_WAIT_MS) {
      return null;
    }
    if (now - callAt >= SAVE_WAIT_MS) {
      return null;
    }
    if (
      started &&
      saves.inFlight.size === 0 &&
      saves.lastDoneAt !== null &&
      now - saves.lastDoneAt >= SAVE_QUIET_MS
    ) {
      return round(saves.lastDoneAt - sinceWall);
    }
    await page.waitForTimeout(SAVE_POLL_MS);
  }
}

/** Integer square of `size` px, centred on the viewport box. */
function centreClip(box, size) {
  return {
    x: Math.round(box.x + (box.width - size) / 2),
    y: Math.round(box.y + (box.height - size) / 2),
    width: size,
    height: size,
  };
}

/** PNG of a clip region. Compare two results with buf.equals(other). */
function clipShot(page, clip) {
  return page.screenshot({
    clip,
    caret: "hide",
    scale: "css",
    timeout: THEME_TIMEOUT_MS,
  });
}

/** Clicks a left sidebar tab, then waits 200 ms for it to show. */
async function openTab(page, name) {
  await page.getByRole("tab", { name }).click();
  await page.waitForTimeout(200);
}

/** True when the label is `name`, or a path that ends in `/ name`. */
function themeLabelIs(label, name) {
  const text = label.trim();
  return text === name || text.endsWith(`/ ${name}`);
}

/**
 * Opens a page from the Layers tab and waits until it is quiet. Not measured:
 * the recording is stopped and dropped.
 */
async function stableClipShot(page, clip) {
  let previous = await clipShot(page, clip);
  const deadline = Date.now() + THEME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(STABLE_SHOT_MS);
    const shot = await clipShot(page, clip);
    if (shot.equals(previous)) {
      return shot;
    }
    previous = shot;
  }
  return previous;
}

async function gotoPage(page, target) {
  await openTab(page, "Layers");
  const item = page.locator(`[data-testid="page-${target.id}"]`);
  await expect(item).toBeVisible();
  await startRecording(page);
  const t0 = await markInput(page);
  await item.getByTestId("page-name").click();
  await page.waitForURL(
    (url) => new URL(url).searchParams.get("page-id") === target.id,
    { timeout: PAGE_SWITCH_TIMEOUT_MS },
  );
  await waitForQuiet(page, t0, {
    quietMs: THEME_QUIET_MS,
    timeoutMs: THEME_TIMEOUT_MS,
  });
  await stopRecording(page);
}

/**
 * Frames one board near the viewport centre, clears the selection and moves
 * the mouse off the canvas. Returns { ok, reason }.
 */
async function frameBoard(page, workspace) {
  try {
    await applyZoom(page, workspace, ["Shift+1"]);
    const target = await findBoardNearCentre(page, workspace);
    if (!target) {
      return { ok: false, reason: "no board title visible at fit zoom" };
    }
    await clickTitle(page, target.x, target.y);
    if (!(await waitUntil(page, () => isSelected(page), SELECT_TIMEOUT_MS))) {
      return { ok: false, reason: "click on board title did not select it" };
    }
    await applyZoom(page, workspace, ["Shift+2"]);
    await page.keyboard.press("Escape");
    const sidebar = await page.getByTestId("left-sidebar").boundingBox();
    if (sidebar) {
      await page.mouse.move(
        sidebar.x + sidebar.width / 2,
        sidebar.y + sidebar.height / 2,
      );
    }
    return { ok: true, reason: null };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

/**
 * Runs the theme switches T1-T3 on the cold page, each followed by a visit to
 * one other page. Returns the scenarios. Never throws: a failure skips the
 * names that did not run yet.
 */
async function runThemeGroup(
  page,
  workspace,
  { fileInfo, cold, pages, saves },
) {
  const names = THEME_SWITCHES.flatMap(([from, to], index) => [
    `T${index + 1} theme ${from} -> ${to}`,
    `T${index + 1} other page in ${to}`,
  ]);
  const scenarios = [];
  const skipRest = (reason) => {
    const rest = names
      .slice(scenarios.length)
      .map((name) => skippedScenario(name, reason));
    rest.forEach((scenario) =>
      console.log(`theme: ${scenario.name} skipped: ${scenario.reason}`),
    );
    return [...scenarios, ...rest];
  };

  try {
    const themes = fileInfo.themes;
    const hasThemes =
      Array.isArray(themes) &&
      ["Light", "Dark", "Mid"].every((name) => themes.includes(name));
    if (!hasThemes) {
      return skipRest(
        "file has no Light/Dark/Mid token themes; generate it with --themed",
      );
    }
    const other =
      pages.find((p) => p.id !== cold.id && /^Screens/.test(p.name)) ??
      pages.find((p) => p.id !== cold.id);
    if (!other) {
      return skipRest("no other page to visit");
    }

    const viewportBox = async () => {
      const box = await workspace.viewport.boundingBox();
      if (!box) {
        throw new Error("viewport is not visible");
      }
      return box;
    };

    await openTab(page, "Tokens");
    const select = page.getByTestId("theme-select");
    try {
      await select.waitFor({
        state: "visible",
        timeout: THEME_SELECT_TIMEOUT_MS,
      });
    } catch (_error) {
      return skipRest("no theme selector in the Tokens tab");
    }

    // Start from Light. Not measured.
    if (!themeLabelIs(await select.innerText(), "Light")) {
      const wall = Date.now();
      await startRecording(page);
      const t0 = await markInput(page);
      await select.click();
      const light = page
        .getByTestId("theme-select-dropdown")
        .getByRole("option", { name: "Light", exact: true });
      await light.waitFor({
        state: "visible",
        timeout: THEME_SELECT_TIMEOUT_MS,
      });
      await light.click();
      await waitForQuiet(page, t0, {
        quietMs: THEME_QUIET_MS,
        timeoutMs: THEME_TIMEOUT_MS,
      });
      await stopRecording(page);
      await waitForSave(page, saves, wall);
      if (!themeLabelIs(await select.innerText(), "Light")) {
        return skipRest("could not select the Light theme");
      }
    }

    // Baseline of the other page in Light.
    await gotoPage(page, other);
    const otherClip = centreClip(await viewportBox(), OTHER_CLIP_PX);
    // The page transition can outlast the quiet wait, so wait for a stable shot.
    let otherOld = await stableClipShot(page, otherClip);
    const otherInitial = otherOld;

    // Baseline of the cold page, framed on one board.
    await gotoPage(page, cold);
    await startRecording(page);
    const frameAt = await markInput(page);
    const framed = await frameBoard(page, workspace);
    if (!framed.ok) {
      await stopRecording(page);
      return skipRest(framed.reason);
    }
    await waitForQuiet(page, frameAt, {
      quietMs: THEME_QUIET_MS,
      timeoutMs: THEME_TIMEOUT_MS,
    });
    await stopRecording(page);
    const coldClip = centreClip(await viewportBox(), THEME_CLIP_PX);
    let coldOld = await clipShot(page, coldClip);
    const coldInitial = coldOld;

    for (const [index, [from, to]] of THEME_SWITCHES.entries()) {
      const n = index + 1;
      const themeName = `T${n} theme ${from} -> ${to}`;
      const otherName = `T${n} other page in ${to}`;

      // Switch the theme on the cold page.
      await openTab(page, "Tokens");
      await select.click();
      const option = page
        .getByTestId("theme-select-dropdown")
        .getByRole("option", { name: to, exact: true });
      await option.waitFor({
        state: "visible",
        timeout: THEME_SELECT_TIMEOUT_MS,
      });

      await startRecording(page);
      const t0 = await markInput(page);
      const wall0 = Date.now();
      const clickDone = option.click({ timeout: THEME_TIMEOUT_MS });
      clickDone.catch(() => {}); // awaited below; no unhandled rejection

      // First visible change: poll the centre square until it differs. A
      // screenshot waits for the main thread, so the change happened after
      // the last unchanged shot returned (firstChangeAfterMs) and before the
      // changed one returned (firstChangeMs).
      let firstChangeMs = null;
      let firstChangeAfterMs = 0;
      let screenshotPolls = 0;
      let screenshotTotalMs = 0;
      const pollDeadline = Date.now() + THEME_TIMEOUT_MS;
      while (Date.now() < pollDeadline) {
        const started = Date.now();
        const shot = await clipShot(page, coldClip);
        const finished = Date.now();
        screenshotPolls++;
        screenshotTotalMs += finished - started;
        if (!shot.equals(coldOld)) {
          firstChangeMs = finished - wall0;
          break;
        }
        firstChangeAfterMs = finished - wall0;
      }
      await clickDone;

      const timeToSharpMs = await waitForSharp(page, t0, {
        timeoutMs: THEME_TIMEOUT_MS,
      });
      const settledMs = await waitForQuiet(page, t0, {
        quietMs: THEME_QUIET_MS,
        timeoutMs: THEME_TIMEOUT_MS,
      });
      const raw = await stopRecording(page);
      const counters = await readCounters(page);
      const label = (await select.innerText()).trim();
      const after = await clipShot(page, coldClip);
      const persistMs = await waitForSave(page, saves, wall0);

      const scenario = buildScenario({
        name: themeName,
        zoom: "board",
        raw,
        timeToSharpMs,
        counters,
        settledMs,
        extra: {
          from,
          to,
          firstChangeMs,
          firstChangeAfterMs,
          screenshotPolls,
          screenshotAvgMs:
            screenshotPolls > 0
              ? round(screenshotTotalMs / screenshotPolls)
              : null,
          ...summarizeBlocking(raw),
          activeTheme: label,
          themeActive: themeLabelIs(label, to),
          canvasChanged: !after.equals(coldOld),
          persistMs,
        },
      });
      scenarios.push(scenario);
      console.log(
        `theme: ${themeName}: first change ${firstChangeAfterMs}-${firstChangeMs} ms, ` +
          `settled ${settledMs} ms, longest task ${scenario.longestTaskMs} ms, ` +
          `TBT ${scenario.totalBlockingTimeMs} ms, save ${persistMs} ms`,
      );

      // Visit the other page and time how long it takes to show the theme.
      await openTab(page, "Layers");
      const otherItem = page.locator(`[data-testid="page-${other.id}"]`);
      await expect(otherItem).toBeVisible();
      await startRecording(page);
      const t1 = await markInput(page);
      const wall1 = Date.now();
      await otherItem.getByTestId("page-name").click();
      await page.waitForURL(
        (url) => new URL(url).searchParams.get("page-id") === other.id,
        { timeout: PAGE_SWITCH_TIMEOUT_MS },
      );
      const sharp = await waitForSharp(page, t1, {
        timeoutMs: THEME_TIMEOUT_MS,
      });

      let previous = null;
      let timeToNewThemeMs = null;
      const otherDeadline = Date.now() + OTHER_WAIT_MS;
      while (Date.now() < otherDeadline) {
        const shot = await clipShot(page, otherClip);
        const shotAt = Date.now();
        if (previous && !shot.equals(otherOld) && shot.equals(previous.shot)) {
          timeToNewThemeMs = previous.at - wall1;
          break;
        }
        previous = { shot, at: shotAt };
        await page.waitForTimeout(OTHER_POLL_MS);
      }
      const otherSettled = await waitForQuiet(page, t1, {
        quietMs: THEME_QUIET_MS,
        timeoutMs: THEME_TIMEOUT_MS,
      });
      const otherRaw = await stopRecording(page);
      const otherCounters = await readCounters(page);
      const final = await stableClipShot(page, otherClip);
      const otherScenario = buildScenario({
        name: otherName,
        zoom: null,
        raw: otherRaw,
        timeToSharpMs: sharp,
        counters: otherCounters,
        settledMs: otherSettled,
        extra: {
          page: other.name,
          toPageId: other.id,
          timeToNewThemeMs,
          newThemeShown: !final.equals(otherOld),
          ...summarizeBlocking(otherRaw),
        },
      });
      scenarios.push(otherScenario);
      console.log(
        `theme: ${otherName}: new theme after ${timeToNewThemeMs} ms, ` +
          `settled ${otherSettled} ms, shown ${otherScenario.newThemeShown}`,
      );
      otherOld = final;

      // Back to the cold page: the baseline for the next switch. Not measured.
      await gotoPage(page, cold);
      coldOld = await clipShot(page, coldClip);
    }

    // Last switch is back to Light: does each page look as it did at first?
    const [themeLast, otherLast] = scenarios.slice(-2);
    themeLast.matchesInitial = coldOld.equals(coldInitial);
    otherLast.matchesInitial = otherOld.equals(otherInitial);
    // Keep the squares that differ, so a person can compare them.
    const outDir = process.env.PENPOT_PERF_OUT
      ? path.resolve(process.env.PENPOT_PERF_OUT)
      : path.resolve(process.cwd(), "tmp/bench");
    const keep = [
      ["cold", themeLast.matchesInitial, coldInitial, coldOld],
      ["other", otherLast.matchesInitial, otherInitial, otherOld],
    ];
    for (const [label, same, before, after] of keep) {
      if (!same) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, `theme-${label}-before.png`), before);
        writeFileSync(path.join(outDir, `theme-${label}-after.png`), after);
      }
    }
    return scenarios;
  } catch (error) {
    return skipRest(`error: ${String(error)}`);
  }
}

test.describe("render-wasm real-file benchmark", () => {
  test.skip(
    process.env.PENPOT_PERF_REAL !== "1",
    "real-file benchmark; set PENPOT_PERF_REAL=1",
  );
  test.describe.configure({ mode: "serial" });

  test("cold open, pan, zoom and page switches on a real file", async ({
    page,
  }) => {
    test.setTimeout(GROUPS.has("theme") ? 120 * 60 * 1000 : 30 * 60 * 1000);

    const startedAt = new Date().toISOString();
    const credentials = readCredentials();
    const fileInfo = readFileInfo();
    const { fileId, teamId, projectId, pages } = fileInfo;

    const cold = pickColdPage(pages);

    await login(page, credentials);
    await addInitScripts(page);
    const saves = trackSaves(page);

    const coldOpenResult = await coldOpen(page, { teamId, fileId, cold });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const viewport = page.viewportSize();
    const deviceScaleFactor = await page.evaluate(
      () => window.devicePixelRatio,
    );
    const gpuRenderer = await readGpuRenderer(page);

    const workspace = { viewport: page.getByTestId("viewport") };
    const scenarios = [];

    if (GROUPS.has("nav")) {
      // Hide the UI and fit, as the mocked spec does after its build step.
      await page.keyboard.press("\\");
      await expect(page.getByTestId("page-name").first()).not.toBeVisible();
      await applyZoom(page, workspace, ["Shift+1"]);

      // S1: wheel pan at each zoom level.
      for (const level of ZOOM_LEVELS) {
        await applyZoom(page, workspace, level.keys);
        scenarios.push(await runWheelPan(page, workspace, level.label));
      }

      // S2: space-drag pan at each zoom level.
      for (const level of ZOOM_LEVELS) {
        await applyZoom(page, workspace, level.keys);
        scenarios.push(await runSpaceDrag(page, workspace, level.label));
      }

      // S3: ctrl-wheel zoom from zoom-to-fit.
      await applyZoom(page, workspace, ["Shift+1"]);
      scenarios.push(await runCtrlWheelZoom(page, workspace, "fit"));

      // S4: zoom-to-fit and reset-zoom, timed from the keypress.
      await applyZoom(page, workspace, ["Shift+0"]);
      scenarios.push(await runKeyZoom(page, "Shift+1"));
      scenarios.push(await runKeyZoom(page, "Shift+0"));

      // Show the UI again for the page list (S6) and the editing scenarios.
      await page.keyboard.press("\\");
      await expect(
        page.locator(`[data-testid="page-${cold.id}"]`),
      ).toBeVisible();
    }

    // S6: page switches. Each other page is visited, then the cold page is
    // opened again. Kept apart from the S1-S4 scenarios.
    const pageSwitches = [];
    if (GROUPS.has("pages")) {
      for (const other of pages.filter((p) => p.id !== cold.id)) {
        pageSwitches.push(await switchPage(page, cold, other));
        pageSwitches.push(await switchPage(page, other, cold));
      }
    }

    // S7-S9: editing one board on the cold page, with the UI visible. Each
    // edit is undone. An edit that fails is skipped, not fatal.
    const editing = [];
    if (GROUPS.has("edit")) {
      const selection = await selectBoard(page, workspace);
      if (!selection.ok) {
        editing.push(
          ...skipEdit(
            [...S7_NAMES, ...S8_NAMES, ...S9_NAMES],
            selection.reason,
          ),
        );
      } else {
        const boardId = selection.id;
        editing.push(
          ...(await runEditStep(S7_NAMES, () => runBoardDrag(page, boardId))),
        );

        if (await ensureSelected(page, workspace, boardId)) {
          editing.push(
            ...(await runEditStep(S8_NAMES, () => runNudges(page, boardId))),
          );
        } else {
          editing.push(...skipEdit(S8_NAMES, "selection lost after S7"));
        }

        if (await ensureSelected(page, workspace, boardId)) {
          editing.push(
            ...(await runEditStep(S9_NAMES, () =>
              runOpacityEdit(page, boardId),
            )),
          );
        } else {
          editing.push(...skipEdit(S9_NAMES, "selection lost after S8"));
        }
      }
      await page.keyboard.press("Escape"); // drop the selection
    }

    // T1-T3: theme switches on the cold page, each with one other page.
    const themeSwitches = GROUPS.has("theme")
      ? await runThemeGroup(page, workspace, { fileInfo, cold, pages, saves })
      : [];

    const result = {
      startedAt,
      baseUrl: BASE_URL,
      fileInfo: { fileId, teamId, projectId, pages },
      gpuRenderer,
      dpr: deviceScaleFactor,
      viewport,
      userAgent,
      coldOpen: coldOpenResult,
      scenarios,
      pageSwitches,
      editing,
      themeSwitches,
    };

    const file = writeResult(result, { prefix: "perf-real-file" });
    printSummary([
      ...scenarios,
      ...pageSwitches,
      ...editing,
      ...themeSwitches,
    ]);
    console.log(`perf results written to ${file}`);

    expect(
      scenarios.length +
        pageSwitches.length +
        editing.length +
        themeSwitches.length,
    ).toBeGreaterThan(0);
  });
});
