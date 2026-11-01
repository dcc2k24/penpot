import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const TILES_TIMEOUT_MS = 10000;
const STEP_MS = 16;
const WHEEL_DURATION_MS = 5000;
const WHEEL_FLIP_MS = 1000;
const WHEEL_DX = 60;
const WHEEL_DY = 40;
const DRAG_STEPS = 60;
const DRAG_STEP_PX = 10;
const DRAG_PAUSE_EVERY = 20;
const DRAG_PAUSE_MS = 150;
const CTRL_WHEEL_MS = 1500;
const CTRL_WHEEL_DY = 100;

// Penpot zooms by a factor of 1.3 per "-" press (zoom.cljs, decrease-zoom).
// 3 presses give about 45.5% and 5 presses about 26.9%. Exact 50% and 25%
// are not reachable with "-" alone, so the labels are approximate.
export const ZOOM_LEVELS = [
  { label: "100%", keys: ["Shift+0"] },
  { label: "~45%", keys: ["Shift+0", "-", "-", "-"] },
  { label: "~27%", keys: ["Shift+0", "-", "-", "-", "-", "-"] },
  { label: "fit", keys: ["Shift+1"] },
];

export function round(value) {
  return value === null || value === undefined
    ? null
    : Math.round(value * 10) / 10;
}

export function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function summarizeFrames(frames) {
  const sorted = [...frames].sort((a, b) => a - b);
  return {
    count: frames.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.length ? sorted[sorted.length - 1] : null),
  };
}

export function summarizeLongTasks(longTasks) {
  return {
    count: longTasks.length,
    totalMs: round(longTasks.reduce((sum, task) => sum + task.duration, 0)),
  };
}

/**
 * Frame recorder, long task observer, wheel timestamp and tiles-complete log.
 * Runs in the browser, so it must not reference any module-level identifier.
 * Installs everything on `window.__perf`. Safe to call twice.
 */
export function installPerfRecorder() {
  if (window.__perf) {
    return;
  }

  const perf = {
    frames: [],
    longTasks: [],
    loafs: [],
    recording: false,
    recordStart: 0,
    lastTilesComplete: null,
    tilesCompleteLog: [],
    lastInputAt: null,
    _lastTs: null,
    _observer: null,
    _loafObserver: null,
  };
  window.__perf = perf;

  const onLongTasks = (entries) => {
    if (!perf.recording) {
      return;
    }
    for (const entry of entries) {
      if (entry.startTime >= perf.recordStart) {
        perf.longTasks.push({
          start: entry.startTime,
          duration: entry.duration,
        });
      }
    }
  };

  const onLoafs = (entries) => {
    if (!perf.recording) {
      return;
    }
    for (const entry of entries) {
      if (entry.startTime >= perf.recordStart) {
        perf.loafs.push({
          start: entry.startTime,
          duration: entry.duration,
          blockingDuration: entry.blockingDuration ?? 0,
        });
      }
    }
  };

  const tick = (ts) => {
    if (perf.recording && perf._lastTs !== null) {
      perf.frames.push(ts - perf._lastTs);
    }
    perf._lastTs = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  try {
    perf._observer = new PerformanceObserver((list) =>
      onLongTasks(list.getEntries()),
    );
    perf._observer.observe({ type: "longtask", buffered: false });
  } catch (_error) {
    perf._observer = null;
  }

  try {
    perf._loafObserver = new PerformanceObserver((list) =>
      onLoafs(list.getEntries()),
    );
    perf._loafObserver.observe({
      type: "long-animation-frame",
      buffered: false,
    });
  } catch (_error) {
    perf._loafObserver = null;
  }

  document.addEventListener("penpot:wasm:tiles-complete", () => {
    const now = performance.now();
    perf.lastTilesComplete = now;
    perf.tilesCompleteLog.push(now);
    if (perf.tilesCompleteLog.length > 500) {
      perf.tilesCompleteLog.shift();
    }
  });

  window.addEventListener(
    "wheel",
    () => {
      perf.lastInputAt = performance.now();
    },
    { capture: true, passive: true },
  );

  // The drag render can finish within a round trip, so stamp pointerup in-page.
  window.addEventListener(
    "pointerup",
    () => {
      perf.lastInputAt = performance.now();
    },
    { capture: true, passive: true },
  );

  perf.startRecording = () => {
    perf.frames = [];
    perf.longTasks = [];
    perf.loafs = [];
    perf.recordStart = performance.now();
    perf.recording = true;
  };

  // Hands over the observer records that have not been delivered yet.
  perf.flush = () => {
    if (perf._observer) {
      onLongTasks(perf._observer.takeRecords());
    }
    if (perf._loafObserver) {
      onLoafs(perf._loafObserver.takeRecords());
    }
  };

  perf.stopRecording = () => {
    perf.flush();
    perf.recording = false;
    return {
      frames: perf.frames.slice(),
      longTasks: perf.longTasks.slice(),
      loafs: perf.loafs.slice(),
    };
  };
}

/**
 * Installs the frame recorder, long task observer, wheel timestamp and
 * tiles-complete log on `window.__perf`. Safe to call twice.
 */
export async function installInstrumentation(page) {
  await page.evaluate(installPerfRecorder);
}

/**
 * Registers the frame recorder to run before any app code on every new
 * document. Use this when the recorder must exist before the app starts.
 */
export async function addInstrumentationInitScript(page) {
  await page.addInitScript(installPerfRecorder);
}

export async function markInput(page) {
  return page.evaluate(() => {
    const now = performance.now();
    window.__perf.lastInputAt = now;
    return now;
  });
}

export async function lastInput(page) {
  return page.evaluate(() => window.__perf.lastInputAt);
}

export async function startRecording(page) {
  await page.evaluate(() => window.__perf.startRecording());
}

export async function stopRecording(page) {
  return page.evaluate(() => window.__perf.stopRecording());
}

/**
 * Waits for the first tiles-complete at or after `sinceMs` (page clock).
 * Returns the delay in ms, or null if none arrives within the timeout
 * (`timeoutMs`, default TILES_TIMEOUT_MS).
 */
export async function waitForSharp(
  page,
  sinceMs,
  { timeoutMs = TILES_TIMEOUT_MS } = {},
) {
  if (sinceMs === null || sinceMs === undefined) {
    return null;
  }
  try {
    await page.waitForFunction(
      (since) => window.__perf.tilesCompleteLog.some((t) => t >= since),
      sinceMs,
      { timeout: timeoutMs, polling: 50 },
    );
  } catch (_error) {
    return null;
  }
  const delay = await page.evaluate((since) => {
    const hit = window.__perf.tilesCompleteLog.find((t) => t >= since);
    return hit === undefined ? null : hit - since;
  }, sinceMs);
  return round(delay);
}

/**
 * Waits until a tiles-complete arrives at or after `sinceMs` and none has
 * arrived for `quietMs`. Returns the delay from `sinceMs` to the last one in
 * ms, or null on timeout.
 */
export async function waitForSettled(
  page,
  sinceMs,
  { quietMs = 500, timeoutMs = TILES_TIMEOUT_MS } = {},
) {
  if (sinceMs === null || sinceMs === undefined) {
    return null;
  }
  try {
    await page.waitForFunction(
      ({ since, quiet }) => {
        const last = window.__perf.tilesCompleteLog
          .filter((t) => t >= since)
          .pop();
        return last !== undefined && performance.now() - last >= quiet;
      },
      { since: sinceMs, quiet: quietMs },
      { timeout: timeoutMs, polling: 50 },
    );
  } catch (_error) {
    return null;
  }
  const last = await page.evaluate((since) => {
    const hits = window.__perf.tilesCompleteLog.filter((t) => t >= since);
    return hits.length === 0 ? null : hits[hits.length - 1];
  }, sinceMs);
  return last === null ? null : round(last - sinceMs);
}

/**
 * Blocking summary of a raw recording. Long tasks count the time over 50 ms.
 * Long animation frames use their own blockingDuration.
 */
export function summarizeBlocking(raw) {
  const longTasks = raw.longTasks ?? [];
  const loafs = raw.loafs ?? [];
  const longest = (items) =>
    items.length === 0
      ? null
      : items.reduce((max, item) => Math.max(max, item.duration), 0);
  return {
    longestTaskMs: round(longest(longTasks)),
    totalBlockingTimeMs: round(
      longTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
    ),
    longestLoafMs: round(longest(loafs)),
    loafBlockingMs: round(
      loafs.reduce((sum, loaf) => sum + (loaf.blockingDuration ?? 0), 0),
    ),
    loafCount: loafs.length,
  };
}

/**
 * Waits until nothing has happened for `quietMs`. Activity is a long task, a
 * long animation frame, a tiles-complete or a change in the render counters.
 * Returns the time from `sinceMs` to the last activity in ms, or null on
 * timeout. Start recording before the input, or long tasks are not seen.
 */
export async function waitForQuiet(
  page,
  sinceMs,
  { quietMs = 1000, timeoutMs = 10 * 60 * 1000 } = {},
) {
  if (sinceMs === null || sinceMs === undefined) {
    return null;
  }
  try {
    await page.waitForFunction(
      ({ since, quiet }) => {
        const perf = window.__perf;
        perf.flush?.();
        let last = since;
        for (const task of perf.longTasks) {
          if (task.start >= since) {
            last = Math.max(last, task.start + task.duration);
          }
        }
        for (const loaf of perf.loafs) {
          if (loaf.start >= since) {
            last = Math.max(last, loaf.start + loaf.duration);
          }
        }
        for (const time of perf.tilesCompleteLog) {
          if (time >= since) {
            last = Math.max(last, time);
          }
        }
        if (typeof window.penpotRenderCounters === "function") {
          let sig;
          try {
            sig = JSON.stringify(window.penpotRenderCounters());
          } catch (error) {
            sig = String(error);
          }
          const state = window.__perfQuietState;
          if (!state || state.since !== since) {
            window.__perfQuietState = { since, sig, changedAt: null };
          } else if (state.sig !== sig) {
            state.sig = sig;
            state.changedAt = performance.now();
          }
          const changedAt = window.__perfQuietState.changedAt;
          if (changedAt !== null) {
            last = Math.max(last, changedAt);
          }
        }
        window.__perfQuietLast = last;
        return performance.now() - last >= quiet;
      },
      { since: sinceMs, quiet: quietMs },
      { timeout: timeoutMs, polling: 100 },
    );
  } catch (_error) {
    return null;
  }
  const last = await page.evaluate(() => window.__perfQuietLast);
  return round(last - sinceMs);
}

export async function readCounters(page) {
  return page.evaluate(() => {
    try {
      const value = window.penpotRenderCounters;
      const resolved = typeof value === "function" ? value() : value;
      if (resolved === undefined || resolved === null) {
        return null;
      }
      return JSON.parse(JSON.stringify(resolved));
    } catch (error) {
      return { error: String(error) };
    }
  });
}

export async function readGpuRenderer(page) {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) {
        return null;
      }
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      if (!ext) {
        return null;
      }
      return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    } catch (_error) {
      return null;
    }
  });
}

/**
 * Returns the centre of the workspace viewport. Accepts either a Playwright
 * Locator or a WorkspacePage-like object with a `viewport` locator.
 */
export async function viewportCentre(target) {
  const viewport =
    typeof target.boundingBox === "function" ? target : target.viewport;
  const box = await viewport.boundingBox();
  if (!box) {
    throw new Error("viewport is not visible");
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
    box,
  };
}

export function buildScenario({
  name,
  zoom,
  raw,
  timeToSharpMs,
  counters,
  settledMs,
  extra,
}) {
  return {
    name,
    zoom,
    frames: summarizeFrames(raw.frames),
    longTasks: summarizeLongTasks(raw.longTasks),
    timeToSharpMs,
    settledMs: settledMs ?? null,
    counters,
    ...(extra ?? {}),
  };
}

/** Marks a scenario that did not run, with the reason. */
export function skippedScenario(name, reason) {
  return { name, skipped: true, reason };
}

/** Presses the zoom keys with the mouse at the viewport centre, then settles. */
export async function applyZoom(page, workspace, keys) {
  const { x, y } = await viewportCentre(workspace);
  await page.mouse.move(x, y);
  const t0 = await markInput(page);
  for (const key of keys) {
    await page.keyboard.press(key);
  }
  await waitForSharp(page, t0);
  await page.waitForTimeout(300);
}

export async function runWheelPan(page, workspace, zoom) {
  const { x, y } = await viewportCentre(workspace);
  await page.mouse.move(x, y);

  await startRecording(page);
  const start = Date.now();
  while (Date.now() - start < WHEEL_DURATION_MS) {
    const phase = Math.floor((Date.now() - start) / WHEEL_FLIP_MS) % 2;
    const dir = phase === 0 ? 1 : -1;
    await page.mouse.wheel(WHEEL_DX * dir, WHEEL_DY * dir);
    await page.waitForTimeout(STEP_MS);
  }
  const inputAt = await lastInput(page);

  // Keep recording until sharp, so a blocking post-gesture render shows up.
  const timeToSharpMs = await waitForSharp(page, inputAt);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  return buildScenario({
    name: `S1 wheel pan @ ${zoom}`,
    zoom,
    raw,
    timeToSharpMs,
    counters,
  });
}

export async function runSpaceDrag(page, workspace, zoom) {
  const { x, y } = await viewportCentre(workspace);
  await page.mouse.move(x, y);

  await startRecording(page);
  await page.keyboard.down("Space");
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step++) {
    await page.mouse.move(x + step * DRAG_STEP_PX, y);
    await page.waitForTimeout(STEP_MS);
    if (step % DRAG_PAUSE_EVERY === 0) {
      await page.waitForTimeout(DRAG_PAUSE_MS);
    }
  }
  await page.mouse.up();
  const inputAt = await lastInput(page);
  await page.keyboard.up("Space");

  const timeToSharpMs = await waitForSharp(page, inputAt);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  return buildScenario({
    name: `S2 space-drag pan @ ${zoom}`,
    zoom,
    raw,
    timeToSharpMs,
    counters,
  });
}

export async function runCtrlWheelZoom(page, workspace, zoom) {
  const { x, y } = await viewportCentre(workspace);
  await page.mouse.move(x, y);

  await startRecording(page);
  await page.keyboard.down("Control");
  for (const dy of [-CTRL_WHEEL_DY, CTRL_WHEEL_DY]) {
    const start = Date.now();
    while (Date.now() - start < CTRL_WHEEL_MS) {
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(STEP_MS);
    }
  }
  await page.keyboard.up("Control");
  const inputAt = await lastInput(page);

  const timeToSharpMs = await waitForSharp(page, inputAt);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  return buildScenario({
    name: `S3 ctrl-wheel zoom @ ${zoom}`,
    zoom,
    raw,
    timeToSharpMs,
    counters,
  });
}

export async function runKeyZoom(page, key) {
  await startRecording(page);
  const t0 = await markInput(page);
  await page.keyboard.press(key);
  const timeToSharpMs = await waitForSharp(page, t0);
  const raw = await stopRecording(page);
  const counters = await readCounters(page);
  return buildScenario({
    name: `S4 key ${key}`,
    zoom: key,
    raw,
    timeToSharpMs,
    counters,
  });
}

export function printSummary(scenarios) {
  const header = [
    "scenario",
    "frames",
    "p50",
    "p95",
    "p99",
    "max",
    "longTasks",
    "longMs",
    "sharpMs",
    "settledMs",
  ];
  const rows = scenarios.map((s) =>
    s.skipped
      ? [s.name, `skipped: ${s.reason}`]
      : [
          s.name,
          s.frames.count,
          s.frames.p50,
          s.frames.p95,
          s.frames.p99,
          s.frames.max,
          s.longTasks.count,
          s.longTasks.totalMs,
          s.timeToSharpMs,
          s.settledMs,
        ],
  );
  const lines = [header, ...rows].map((row) =>
    row
      .map((cell, index) =>
        String(cell ?? "-").padEnd(index === 0 ? 30 : 10),
      )
      .join(" "),
  );
  console.log(lines.join("\n"));
}

export function writeResult(result, { prefix = "perf-navigation" } = {}) {
  const outDir = process.env.PENPOT_PERF_OUT
    ? path.resolve(process.env.PENPOT_PERF_OUT)
    : path.resolve(process.cwd(), "tmp/bench");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(
    outDir,
    `${prefix}-${result.startedAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}
