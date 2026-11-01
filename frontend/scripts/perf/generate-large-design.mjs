// Creates a large benchmark file in a local Penpot and fills it with the
// large-design plugin. Run from the repo root. See README.md in this folder.

import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "http://localhost:3450";
const PLUGIN_PATH = fileURLToPath(
  new URL("./large-design-plugin.js", import.meta.url),
);
const PARAMS_TOKEN = "__PARAMS__";
// The plugin loader requires a UUID for pluginId. Permission checks look the
// plugin up in the installed-plugins registry, which `ɵloadPlugin` skips; the
// nil UUID is the internal id that bypasses that lookup (register.cljs
// `check-permission`), so `library:write` calls like createComponent work.
const PLUGIN_ID = "00000000-0000-0000-0000-000000000000";
// The loader fetches manifest.code from manifest.host when host is set, so the
// plugin source is served from this path on the page origin (see drive()).
const PLUGIN_ROUTE = "/__large-design__/plugin.js";
const LOG_PREFIX = "[large-design] ";
// Plugin warnings. They are printed but never end the run.
const WARN_PREFIX = "[large-design-warn]";
const COUNT_PREFIX = "COUNT ";
const SAVE_URL_PART = "/api/main/methods/update-file";

const WORKSPACE_TIMEOUT_MS = 180_000;
// Batched runs load big files, which is slow, so they wait longer for the
// viewport.
const BATCH_WORKSPACE_TIMEOUT_MS = 10 * 60 * 1000;
const LOADER_TIMEOUT_MS = 180_000;
const SAVE_QUIET_MS = 15_000;
// Runs with more screens than this get the longer timeouts (see runTimeoutMs
// and saveCapMs).
const LARGE_RUN_SCREENS = 200;
const INIT_TIMEOUT_MS = 60 * 60 * 1000;
const COUNT_TIMEOUT_MS = 30 * 60 * 1000;

const USAGE = `Usage: node frontend/scripts/perf/generate-large-design.mjs [options]

Options:
  --screen-pages N         screen pages to create (integer >= 0, default 4)
  --screens-per-page N     screens on each screen page (integer >= 1, default 30)
  --table-rows N           rows in each table (integer >= 1, default 12)
  --single-page-screens N  screens on one extra "Enterprise app" page, all screen kinds mixed (integer >= 0, default 0)
  --seed N                 random seed (any integer, default 42)
  --build-single-page N    build an Enterprise app page of N screens in batches (integer >= 1, needs PENPOT_BENCH_FILE_INFO)
  --batch N                screens per batch for --build-single-page (integer >= 1, default 50)
  --append-to PATH         add screens to the file described by the file info JSON at PATH
  --append-screens N       screens to add with --append-to (integer >= 1, default 50)
  --themed                 add token themes Light, Dark and Mid and bind their tokens
  --verify-theme NAME      check the file in PENPOT_BENCH_FILE_INFO against theme NAME (changes nothing)
  --headed                 show the browser window
  --help                   print this help

Environment:
  PENPOT_BASE_URL, PENPOT_BENCH_CREDENTIALS, PENPOT_BENCH_FILE_INFO,
  PENPOT_BENCH_NODE_MODULES`;

const INT_FLAGS = new Map([
  ["--screen-pages", { key: "screenPages", min: 0 }],
  ["--screens-per-page", { key: "screensPerPage", min: 1 }],
  ["--table-rows", { key: "tableRows", min: 1 }],
  ["--single-page-screens", { key: "singlePageScreens", min: 0 }],
  ["--seed", { key: "seed", min: null }],
  ["--build-single-page", { key: "buildSinglePage", min: 1 }],
  ["--batch", { key: "batch", min: 1 }],
  ["--append-screens", { key: "appendScreens", min: 1 }],
]);

const STRING_FLAGS = new Map([
  ["--append-to", { key: "appendTo" }],
  ["--verify-theme", { key: "verifyTheme" }],
]);

// Fields that every batched run needs from the file info JSON.
const FILE_INFO_FIELDS = [
  "fileId",
  "teamId",
  "enterprisePageId",
  "seed",
  "tableRows",
  "layoutCapacity",
];

// Theme names that `--themed` creates. Used when the plugin does not report them.
const THEME_NAMES = ["Light", "Dark", "Mid"];

// Extra DONE fields that the plugin reports in some modes.
const DONE_FIELDS = [
  "count",
  "screens",
  "startIndex",
  "endIndex",
  "themes",
  "bindings",
  "theme",
  "activeThemes",
  "checked",
  "mismatched",
  "examples",
  "coverage",
  "perPage",
];

class UsageError extends Error {}

class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function secondsSince(startMs) {
  return Number(((Date.now() - startMs) / 1000).toFixed(1));
}

function parseInteger(flag, raw, min) {
  if (raw === undefined || !/^-?\d+$/.test(raw)) {
    throw new UsageError(`${flag} needs a whole number`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new UsageError(`${flag} is too large`);
  }
  if (min !== null && value < min) {
    throw new UsageError(`${flag} must be at least ${min}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    screenPages: 4,
    screensPerPage: 30,
    tableRows: 12,
    singlePageScreens: 0,
    seed: 42,
    buildSinglePage: null,
    batch: 50,
    appendTo: null,
    appendScreens: 50,
    themed: false,
    verifyTheme: null,
    headed: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    }
    if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--themed") {
      options.themed = true;
    } else if (INT_FLAGS.has(arg)) {
      const { key, min } = INT_FLAGS.get(arg);
      i += 1;
      options[key] = parseInteger(arg, argv[i], min);
    } else if (STRING_FLAGS.has(arg)) {
      const { key } = STRING_FLAGS.get(arg);
      i += 1;
      const value = argv[i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      options[key] = value;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (options.appendTo !== null && options.buildSinglePage !== null) {
    throw new UsageError(
      "--append-to and --build-single-page cannot be used together",
    );
  }
  return options;
}

function validateOptions(options) {
  if (options.buildSinglePage !== null && !process.env.PENPOT_BENCH_FILE_INFO) {
    throw new UsageError(
      "--build-single-page needs PENPOT_BENCH_FILE_INFO set to the file info path",
    );
  }
  if (options.verifyTheme !== null) {
    if (options.appendTo !== null || options.buildSinglePage !== null) {
      throw new UsageError(
        "--verify-theme cannot be used with --append-to or --build-single-page",
      );
    }
    if (!process.env.PENPOT_BENCH_FILE_INFO) {
      throw new UsageError(
        "--verify-theme needs PENPOT_BENCH_FILE_INFO set to the file info path",
      );
    }
  }
}

function totalScreens(options) {
  return options.screenPages * options.screensPerPage + options.singlePageScreens;
}

function runTimeoutMs(options) {
  return totalScreens(options) > LARGE_RUN_SCREENS
    ? 3 * 60 * 60 * 1000
    : 60 * 60 * 1000;
}

function saveCapMs(options) {
  return totalScreens(options) > LARGE_RUN_SCREENS
    ? 30 * 60 * 1000
    : 10 * 60 * 1000;
}

async function loadPlaywright() {
  try {
    return await import("@playwright/test");
  } catch (err) {
    const dir = process.env.PENPOT_BENCH_NODE_MODULES;
    if (!dir) throw err;
    return createRequire(join(dir, "package.json"))("@playwright/test");
  }
}

function randomFrom(chars) {
  return chars[randomInt(chars.length)];
}

function makePassword() {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "!@#$%^&*-_";
  const all = upper + lower + digits + special;
  const chars = [
    randomFrom(upper),
    randomFrom(lower),
    randomFrom(digits),
    randomFrom(special),
  ];
  while (chars.length < 20) chars.push(randomFrom(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function makeCredentials() {
  const hex = randomBytes(4).toString("hex");
  return {
    email: `bench-${hex}@example.com`,
    fullname: `Bench ${hex}`,
    password: makePassword(),
  };
}

function parseCredentials(raw, path) {
  // Do not pass JSON.parse's message on: it can quote part of the file.
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`credentials file is not valid JSON: ${path}`);
  }
  const { email, password, fullname } = data ?? {};
  if (!email || !password || !fullname) {
    throw new Error(`credentials file needs email, password and fullname: ${path}`);
  }
  return { email, password, fullname };
}

async function loadOrCreateCredentials(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const creds = makeCredentials();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, "utf8");
    console.log(`[bench] created credentials file ${path} for ${creds.email}`);
    return { creds, created: true };
  }
  return { creds: parseCredentials(raw, path), created: false };
}

async function rpc(api, base, command, body) {
  const response = await api.post(`${base}/api/main/methods/${command}`, {
    headers: { "content-type": "application/json", accept: "application/json" },
    data: body,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok()) {
    const parts = payload && typeof payload === "object"
      ? [payload.type, payload.code, payload.hint].filter(Boolean)
      : [];
    const detail = parts.length > 0 ? parts.join(" / ") : `HTTP ${response.status()}`;
    throw new RpcError(`${command} failed: ${detail}`, payload?.code ?? null);
  }
  return payload;
}

async function registerProfile(api, base, creds) {
  try {
    const { token } = await rpc(api, base, "prepare-register-profile", {
      fullname: creds.fullname,
      email: creds.email,
      password: creds.password,
    });
    await rpc(api, base, "register-profile", { token });
    console.log(`[bench] registered ${creds.email}`);
  } catch (err) {
    if (err instanceof RpcError && err.code === "email-already-exists") {
      console.log(`[bench] ${creds.email} already exists, logging in`);
      return;
    }
    throw err;
  }
}

async function login(api, base, creds) {
  await rpc(api, base, "login-with-password", {
    email: creds.email,
    password: creds.password,
  });
  console.log(`[bench] logged in as ${creds.email}`);
}

function pickDefault(items, label) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`no ${label} found for this account`);
  }
  return items.find((item) => item.isDefault === true) ?? items[0];
}

// Returns the default team and project of the account. Only needed when a
// file is created.
async function resolveDefaultTeamProject(api, base) {
  const teams = await rpc(api, base, "get-teams", {});
  const team = pickDefault(teams, "team");
  const projects = await rpc(api, base, "get-projects", { "team-id": team.id });
  const project = pickDefault(projects, "project");
  return { teamId: team.id, projectId: project.id };
}

async function createFile(api, base, projectId) {
  const name = `Large design ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const file = await rpc(api, base, "create-file", {
    name,
    "project-id": projectId,
  });
  if (!file?.id) throw new Error("create-file returned no file id");
  const pages = file.data?.pages;
  const pageId = Array.isArray(pages) && pages.length > 0 ? String(pages[0]) : null;
  return { fileId: file.id, pageId };
}

// Reads the file back and checks that each finished page is saved.
async function verifyPagesOnBackend(api, base, fileId, pages) {
  const saved = await rpc(api, base, "get-file", { id: fileId });
  const savedNames = new Set(
    Object.values(saved?.data?.pagesIndex ?? {}).map((p) => p.name),
  );
  const missing = pages.filter((p) => !savedNames.has(p.name));
  if (missing.length > 0) {
    throw new Error(
      `backend file is missing pages: ${missing.map((p) => p.name).join(", ")}`,
    );
  }
  console.log(`[bench] verified ${savedNames.size} pages on the backend`);
}

function workspaceUrl(base, teamId, fileId, pageId) {
  const params = new URLSearchParams({
    screen: "workspace",
    "team-id": teamId,
    "file-id": fileId,
  });
  if (pageId) params.set("page-id", pageId);
  return `${base}/?${params.toString()}`;
}

async function buildPluginCode(params) {
  const source = await readFile(PLUGIN_PATH, "utf8");
  if (source.split(PARAMS_TOKEN).length !== 2) {
    throw new Error(`plugin source must contain ${PARAMS_TOKEN} exactly once`);
  }
  const json = JSON.stringify(params);
  return source.replace(PARAMS_TOKEN, () => json);
}

function buildManifest(code) {
  return {
    pluginId: PLUGIN_ID,
    name: "Large design generator",
    description: "Generates a large design-system and screens benchmark file",
    version: 2,
    code,
    permissions: ["content:read", "content:write", "library:read", "library:write"],
    allowBackground: false,
  };
}

function createOutcome() {
  let settled = false;
  let resolveOutcome;
  const promise = new Promise((resolve) => {
    resolveOutcome = resolve;
  });
  return {
    promise,
    // Set from a `COUNT <n>` line (count mode).
    count: null,
    settle(result) {
      if (settled) return;
      settled = true;
      resolveOutcome(result);
    },
  };
}

function parseDone(json) {
  try {
    const done = JSON.parse(json);
    const result = { ok: true, pages: Array.isArray(done.pages) ? done.pages : [] };
    for (const field of DONE_FIELDS) {
      if (done[field] !== undefined) result[field] = done[field];
    }
    return result;
  } catch {
    return { ok: false, message: "could not parse the DONE line" };
  }
}

function watchPluginLog(page, outcome) {
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith(WARN_PREFIX)) {
      console.log(text);
      return;
    }
    if (!text.startsWith(LOG_PREFIX)) return;
    console.log(text);
    const body = text.slice(LOG_PREFIX.length);
    if (body.startsWith("DONE ")) {
      outcome.settle(parseDone(body.slice("DONE ".length)));
    } else if (body.startsWith("ERROR")) {
      outcome.settle({ ok: false, message: body });
    } else if (body.startsWith(COUNT_PREFIX)) {
      const raw = body.slice(COUNT_PREFIX.length).trim();
      if (/^\d+$/.test(raw)) outcome.count = Number(raw);
    }
  });
}

function watchSaves(page) {
  const save = { inFlight: new Set(), lastActivity: Date.now(), failures: 0, completed: 0 };
  const isSave = (request) => request.url().includes(SAVE_URL_PART);
  const startedAt = new Map();
  page.on("request", (request) => {
    if (!isSave(request)) return;
    save.inFlight.add(request);
    save.lastActivity = Date.now();
    startedAt.set(request, Date.now());
    console.log(`[bench] save sent (${save.inFlight.size} in flight)`);
  });
  const finish = (request) => {
    if (!save.inFlight.delete(request)) return;
    save.lastActivity = Date.now();
    const seconds = (Date.now() - (startedAt.get(request) ?? Date.now())) / 1000;
    startedAt.delete(request);
    console.log(`[bench] save done in ${seconds.toFixed(1)}s`);
  };
  page.on("requestfinished", (request) => {
    if (save.inFlight.has(request)) save.completed += 1;
    finish(request);
  });
  page.on("requestfailed", (request) => {
    if (!isSave(request)) return;
    save.failures += 1;
    console.log("[bench] a save request failed");
    finish(request);
  });
  page.on("response", (response) => {
    if (isSave(response.request()) && response.status() >= 400) {
      save.failures += 1;
      console.log(`[bench] a save request got HTTP ${response.status()}`);
    }
  });
  return save;
}

async function waitForSaves(save, capMs) {
  const started = Date.now();
  // Persistence is batched and may not have started when the plugin reports
  // DONE, so wait for at least one save after DONE before trusting quiet time.
  const savesAtDone = save.completed;
  save.lastActivity = Date.now();
  for (;;) {
    const quiet = Date.now() - save.lastActivity >= SAVE_QUIET_MS;
    const savedSinceDone = save.completed > savesAtDone;
    if (save.inFlight.size === 0 && quiet && savedSinceDone) return;
    // Unsaved changes are lost with the tab, so stop waiting at once.
    if (save.pageGone) {
      throw new Error(`${save.pageGone} while waiting for saves`);
    }
    if (Date.now() - started > capMs) {
      throw new Error("timed out waiting for saves to finish");
    }
    await sleep(1000);
  }
}

function injectPlugin(page, manifest) {
  return page.evaluate(
    async ({ manifest }) => {
      await globalThis.ɵloadPlugin({ ...manifest, host: location.origin });
    },
    { manifest },
  );
}

// Opens a new browser context and logs in. Creates the account first when the
// credentials file is new. Closes the context if login fails.
async function openSession(browser, base, credsPath) {
  const context = await browser.newContext();
  try {
    const api = context.request;
    const { creds, created } = await loadOrCreateCredentials(credsPath);
    if (created) await registerProfile(api, base, creds);
    await login(api, base, creds);
    return { context, api, creds };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// Runs the plugin once, in a new page of `context`. The page is closed at the
// end. Returns the DONE data (`finished`), the time the plugin was injected
// (`injectedAt`) and the number of completed saves (`saveCount`).
async function runPluginOnce(context, url, params, options) {
  const { timeoutMs, workspaceTimeoutMs, waitSaves, saveCap } = options;
  const page = await context.newPage();
  const code = await buildPluginCode(params);
  await page.route(`**${PLUGIN_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: code }),
  );
  const outcome = createOutcome();
  const save = watchSaves(page);
  watchPluginLog(page, outcome);
  page.on("close", () => {
    save.pageGone = save.pageGone ?? "page closed";
    outcome.settle({ ok: false, message: "page closed before the plugin finished" });
  });
  // A renderer crash (e.g. out of memory) fires no close event.
  page.on("crash", () => {
    save.pageGone = "page crashed (likely out of memory)";
    outcome.settle({ ok: false, message: "page crashed (likely out of memory)" });
  });

  const timer = setTimeout(() => {
    outcome.settle({
      ok: false,
      message: `timed out after ${timeoutMs / 60_000} minutes`,
    });
  }, timeoutMs);

  try {
    console.log(`[bench] opening ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page
      .getByTestId("viewport")
      .waitFor({ state: "visible", timeout: workspaceTimeoutMs });
    console.log("[bench] workspace is ready");

    await page.waitForFunction(
      () => typeof globalThis.ɵloadPlugin === "function",
      null,
      { timeout: LOADER_TIMEOUT_MS },
    );
    console.log("[bench] loading plugin");
    const injectedAt = Date.now();
    injectPlugin(page, buildManifest(PLUGIN_ROUTE)).catch((err) => {
      outcome.settle({ ok: false, message: `plugin injection failed: ${err.message}` });
    });

    const finished = await outcome.promise;
    if (!finished.ok) throw new Error(`plugin failed: ${finished.message}`);
    if (finished.count === undefined && outcome.count !== null) {
      finished.count = outcome.count;
    }
    console.log(`[bench] plugin finished in ${secondsSince(injectedAt).toFixed(1)}s`);

    if (waitSaves) {
      console.log("[bench] plugin finished, waiting for saves");
      await waitForSaves(save, saveCap);
      if (save.failures > 0) {
        throw new Error(`${save.failures} save request(s) failed`);
      }
      console.log(`[bench] saves finished (${save.completed} update-file calls)`);
    }
    return { finished, injectedAt, saveCount: save.completed };
  } finally {
    clearTimeout(timer);
    await page.close().catch(() => {});
  }
}

async function drive(browser, base, credsPath, options) {
  const { context, api } = await openSession(browser, base, credsPath);
  const { teamId, projectId } = await resolveDefaultTeamProject(api, base);
  const { fileId, pageId } = await createFile(api, base, projectId);
  const url = workspaceUrl(base, teamId, fileId, pageId);
  console.log(`[bench] created file ${fileId}`);

  const { finished, injectedAt } = await runPluginOnce(
    context,
    url,
    {
      screenPages: options.screenPages,
      screensPerPage: options.screensPerPage,
      tableRows: options.tableRows,
      singlePageScreens: options.singlePageScreens,
      seed: options.seed,
      themed: options.themed,
    },
    {
      timeoutMs: runTimeoutMs(options),
      workspaceTimeoutMs: WORKSPACE_TIMEOUT_MS,
      waitSaves: true,
      saveCap: saveCapMs(options),
    },
  );

  // Read the file back so a run that lost its changes fails loudly.
  await verifyPagesOnBackend(api, base, fileId, finished.pages);
  const generationSeconds = secondsSince(injectedAt);
  console.log(`[bench] total generation time ${generationSeconds.toFixed(1)}s`);

  const result = {
    fileId,
    teamId,
    projectId,
    pages: finished.pages,
    url,
    generationSeconds,
  };
  if (options.themed) {
    console.log(`[bench] themed: ${finished.bindings} token bindings`);
    result.themed = true;
    result.themes = finished.themes ?? THEME_NAMES;
  }
  return result;
}

// Runs fn with a new browser, and closes the browser afterwards. Each batch
// uses its own browser so memory starts fresh.
async function withFreshBrowser(headed, fn) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: !headed });
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

function readBenchEnv() {
  const base = (process.env.PENPOT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const credsPath =
    process.env.PENPOT_BENCH_CREDENTIALS ||
    join(homedir(), "penpot-bench", "bench-user.json");
  return { base, credsPath };
}

// Returns null when the file does not exist.
async function readFileInfo(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new UsageError(`file info is not valid JSON: ${path}`);
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw new UsageError(`file info must be a JSON object: ${path}`);
  }
  return info;
}

async function writeFileInfo(path, info) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

function requireFileInfoFields(info, path) {
  const missing = FILE_INFO_FIELDS.filter(
    (field) => info[field] === undefined || info[field] === null,
  );
  if (missing.length > 0) {
    throw new UsageError(`file info ${path} is missing: ${missing.join(", ")}`);
  }
}

function recordBatch(info, count, seconds) {
  info.enterpriseScreens = count;
  info.batches = (info.batches ?? 0) + 1;
  info.generationSeconds = Number(
    ((info.generationSeconds ?? 0) + seconds).toFixed(1),
  );
}

// Counts the screens on the Enterprise app page. Runs in its own context.
async function countScreens(browser, base, credsPath, info) {
  const { context } = await openSession(browser, base, credsPath);
  try {
    const url = workspaceUrl(base, info.teamId, info.fileId, info.enterprisePageId);
    const { finished } = await runPluginOnce(
      context,
      url,
      { mode: "count", seed: info.seed, tableRows: info.tableRows },
      {
        timeoutMs: COUNT_TIMEOUT_MS,
        workspaceTimeoutMs: BATCH_WORKSPACE_TIMEOUT_MS,
        waitSaves: false,
        saveCap: 0,
      },
    );
    if (typeof finished.count !== "number") {
      throw new Error("the count run did not report a screen count");
    }
    console.log(`[bench] count ${finished.count}`);
    return finished.count;
  } finally {
    await context.close().catch(() => {});
  }
}

// Appends n screens to the Enterprise app page, each step in a fresh browser,
// then counts the page and checks that it grew by n. `before` is the count
// before this batch. `themed` makes the new screens use the token themes.
// Returns the new count and the batch seconds.
async function appendBatch(base, credsPath, info, n, headed, before, themed) {
  const { finished, seconds } = await withFreshBrowser(headed, async (browser) => {
    const { context } = await openSession(browser, base, credsPath);
    const url = workspaceUrl(base, info.teamId, info.fileId, info.enterprisePageId);
    const run = await runPluginOnce(
      context,
      url,
      {
        mode: "append",
        appendScreens: n,
        // Each save costs the backend time in proportion to the page size and
        // the change size. At 220 screens a 5-screen save took about a minute;
        // 10-25 screens in one save never finished (the frontend gives a save
        // request 7 minutes). Pausing every 5 screens keeps each save small.
        savePauseEvery: 5,
        savePauseMs: 10000,
        seed: info.seed,
        tableRows: info.tableRows,
        layoutCapacity: info.layoutCapacity,
        themed,
      },
      {
        // Each screen gets slower as the page grows (a 50-screen batch took
        // 8 minutes on an empty page and over 60 at 200 screens), so the
        // timeout only guards against a hung tab.
        timeoutMs: 3 * 60 * 60 * 1000,
        workspaceTimeoutMs: BATCH_WORKSPACE_TIMEOUT_MS,
        waitSaves: true,
        saveCap: 30 * 60 * 1000,
      },
    );
    return { finished: run.finished, seconds: secondsSince(run.injectedAt) };
  });

  if (
    !Number.isSafeInteger(finished.startIndex) ||
    !Number.isSafeInteger(finished.endIndex)
  ) {
    throw new Error("the append run did not report its screen range");
  }
  console.log(
    `[bench] batch appended ${finished.startIndex}..${finished.endIndex} in ${seconds.toFixed(1)}s`,
  );

  const count = await withFreshBrowser(headed, (browser) =>
    countScreens(browser, base, credsPath, info),
  );
  const expected = before + n;
  if (count !== expected) {
    throw new Error(`screen count is ${count}, expected ${expected}`);
  }
  return { count, seconds };
}

// --append-to <path>: adds one batch to an existing batched file.
async function appendToFile(options) {
  const path = options.appendTo;
  const info = await readFileInfo(path);
  if (info === null) throw new UsageError(`file info not found: ${path}`);
  requireFileInfoFields(info, path);
  const { base, credsPath } = readBenchEnv();

  const before = await withFreshBrowser(options.headed, (browser) =>
    countScreens(browser, base, credsPath, info),
  );
  if (before !== info.enterpriseScreens) {
    console.log(
      `[bench] file info says ${info.enterpriseScreens} screens, the page has ${before}`,
    );
  }

  const { count, seconds } = await appendBatch(
    base,
    credsPath,
    info,
    options.appendScreens,
    options.headed,
    before,
    options.themed || info.themed === true,
  );
  recordBatch(info, count, seconds);
  await writeFileInfo(path, info);
  return info;
}

// --build-single-page <total>: builds the Enterprise app page in batches and
// saves the file info after each batch. Reruns resume from the saved count.
async function buildSinglePage(options) {
  const { base, credsPath } = readBenchEnv();
  const infoPath = process.env.PENPOT_BENCH_FILE_INFO;
  const total = options.buildSinglePage;
  const headed = options.headed;

  let info = await readFileInfo(infoPath);
  if (info !== null && info.enterprisePageId) {
    requireFileInfoFields(info, infoPath);
    console.log(`[bench] resuming ${info.fileId}`);
    if (info.layoutCapacity < total) {
      console.log(
        `[bench] warning: sections were sized for ${info.layoutCapacity} screens, not ${total}`,
      );
    }
  } else {
    if (info !== null) {
      console.log(`[bench] ${infoPath} has no Enterprise app page, creating a new file`);
    }
    const created = await withFreshBrowser(headed, async (browser) => {
      const { context, api } = await openSession(browser, base, credsPath);
      const { teamId, projectId } = await resolveDefaultTeamProject(api, base);
      const { fileId, pageId } = await createFile(api, base, projectId);
      console.log(`[bench] created file ${fileId}`);

      const run = await runPluginOnce(
        context,
        workspaceUrl(base, teamId, fileId, pageId),
        {
          mode: "init",
          seed: options.seed,
          tableRows: options.tableRows,
          layoutCapacity: total,
          themed: options.themed,
        },
        {
          timeoutMs: INIT_TIMEOUT_MS,
          workspaceTimeoutMs: WORKSPACE_TIMEOUT_MS,
          waitSaves: true,
          saveCap: 10 * 60 * 1000,
        },
      );
      await verifyPagesOnBackend(api, base, fileId, run.finished.pages);

      const enterprise = run.finished.pages.find((p) => p.name === "Enterprise app");
      if (!enterprise) {
        throw new Error("the init run did not report the Enterprise app page");
      }
      return {
        fileId,
        teamId,
        projectId,
        pages: run.finished.pages,
        enterprisePageId: enterprise.id,
        themes: run.finished.themes ?? THEME_NAMES,
        generationSeconds: secondsSince(run.injectedAt),
      };
    });

    info = {
      fileId: created.fileId,
      teamId: created.teamId,
      projectId: created.projectId,
      url: workspaceUrl(base, created.teamId, created.fileId, created.enterprisePageId),
      pages: created.pages,
      seed: options.seed,
      tableRows: options.tableRows,
      layoutCapacity: total,
      themed: options.themed,
      ...(options.themed ? { themes: created.themes } : {}),
      enterprisePageId: created.enterprisePageId,
      enterpriseScreens: 0,
      batches: 0,
      generationSeconds: created.generationSeconds,
    };
    await writeFileInfo(infoPath, info);
    console.log(`[bench] Enterprise app page ${info.enterprisePageId} is ready`);
  }

  let current = await withFreshBrowser(headed, (browser) =>
    countScreens(browser, base, credsPath, info),
  );
  info.enterpriseScreens = current;
  await writeFileInfo(infoPath, info);

  while (current < total) {
    const n = Math.min(options.batch, total - current);
    const result = await appendBatch(
      base,
      credsPath,
      info,
      n,
      headed,
      current,
      options.themed || info.themed === true,
    );
    current = result.count;
    recordBatch(info, current, result.seconds);
    await writeFileInfo(infoPath, info);
    console.log(`[bench] progress ${current}/${total} screens`);
  }

  console.log(`[bench] verified COUNT ${current}`);
  return info;
}

// --verify-theme NAME: checks the token colours of the file in
// PENPOT_BENCH_FILE_INFO against one theme. Changes nothing, and does not write
// the file info. Returns the counts. main() sets the exit code.
async function verifyTheme(options) {
  const { base, credsPath } = readBenchEnv();
  const infoPath = process.env.PENPOT_BENCH_FILE_INFO;
  const info = await readFileInfo(infoPath);
  if (info === null) throw new UsageError(`file info not found: ${infoPath}`);
  const missing = ["fileId", "teamId"].filter(
    (field) => info[field] === undefined || info[field] === null,
  );
  if (missing.length > 0) {
    throw new UsageError(`file info ${infoPath} is missing: ${missing.join(", ")}`);
  }
  // Any page opens the workspace. The plugin checks every page.
  const pageId = info.pages?.[0]?.id ?? info.enterprisePageId ?? null;

  const run = await withFreshBrowser(options.headed, async (browser) => {
    const { context } = await openSession(browser, base, credsPath);
    try {
      return await runPluginOnce(
        context,
        workspaceUrl(base, info.teamId, info.fileId, pageId),
        { mode: "verify-theme", theme: options.verifyTheme },
        {
          timeoutMs: 60 * 60 * 1000,
          workspaceTimeoutMs: BATCH_WORKSPACE_TIMEOUT_MS,
          waitSaves: false,
          saveCap: 0,
        },
      );
    } finally {
      await context.close().catch(() => {});
    }
  });
  const { finished, injectedAt } = run;
  if (typeof finished.checked !== "number") {
    throw new Error("the verify run did not report counts");
  }

  const theme = finished.theme ?? options.verifyTheme;
  const { checked, mismatched, coverage } = finished;
  const perPage = finished.perPage ?? [];
  const examples = finished.examples ?? [];
  console.log(
    `[bench] verify theme ${theme}: ${checked} checked, ${mismatched} mismatched`,
  );
  console.log(
    `[bench] coverage: ${coverage.bound} of ${coverage.colored} coloured shapes have a colour token`,
  );
  for (const page of perPage) {
    console.log(
      `[bench]   ${page.name}: ${page.checked} checked, ${page.mismatched} mismatched`,
    );
  }
  for (const example of examples) {
    console.log(`[bench] mismatch ${JSON.stringify(example)}`);
  }

  return {
    theme,
    activeThemes: finished.activeThemes ?? [],
    checked,
    mismatched,
    coverage,
    perPage,
    examples,
    seconds: secondsSince(injectedAt),
  };
}

async function runBench(options) {
  const { base, credsPath } = readBenchEnv();
  return withFreshBrowser(options.headed, (browser) =>
    drive(browser, base, credsPath, options),
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    validateOptions(options);
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    process.exitCode = 0;
    return;
  }

  try {
    if (options.appendTo !== null) {
      const info = await appendToFile(options);
      console.log(JSON.stringify(info));
    } else if (options.buildSinglePage !== null) {
      const info = await buildSinglePage(options);
      console.log(JSON.stringify(info));
    } else if (options.verifyTheme !== null) {
      const result = await verifyTheme(options);
      // Print the result before any failure, so the counts stay the last JSON line.
      console.log(JSON.stringify(result));
      if (result.checked === 0) {
        throw new Error("no shapes with colour tokens found");
      }
      if (result.mismatched > 0) {
        throw new Error(
          `${result.mismatched} of ${result.checked} token colours do not match theme ${result.theme}`,
        );
      }
    } else {
      const result = await runBench(options);
      const line = JSON.stringify(result);
      console.log(line);
      const infoPath = process.env.PENPOT_BENCH_FILE_INFO;
      if (infoPath) {
        await mkdir(dirname(infoPath), { recursive: true });
        await writeFile(infoPath, `${line}\n`, "utf8");
      }
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`[bench] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  }
}

main().catch((err) => {
  console.error(`[bench] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
