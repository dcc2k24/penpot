import { test, expect } from "@playwright/test";
import { WasmWorkspacePage } from "../pages/WasmWorkspacePage";
import {
  ZOOM_LEVELS,
  installInstrumentation,
  readGpuRenderer,
  applyZoom,
  viewportCentre,
  runWheelPan,
  runSpaceDrag,
  runCtrlWheelZoom,
  runKeyZoom,
  printSummary,
  writeResult,
} from "../../helpers/perf-metrics";

// Base fixtures, with the file and page ids used by texts.spec.js and
// shapes.spec.js. Pick one with PENPOT_PERF_FIXTURE (default: texts-shadows).
const FIXTURES = {
  // Text in frames with strokes, shadows and blurs.
  "texts-shadows": {
    file: "render-wasm/get-file-frame-clipping-shadows-and-texts.json",
    fileId: "44471494-966a-8178-8006-c5bd93f0fe72",
    pageId: "44471494-966a-8178-8006-c5bd93f0fe73",
  },
  // Boards with flex layouts: closest to a page of UI components.
  "flex-layouts": {
    file: "render-wasm/get-file-flex-layouts.json",
    fileId: "31fe2e21-73e7-80f3-8007-73894fb58240",
    pageId: "02e9633d-4ce7-80da-8007-736558496fa8",
  },
  shadows: {
    file: "render-wasm/get-file-shadows.json",
    fileId: "9502081a-e1a4-80bc-8006-c2b968723199",
    pageId: "9502081a-e1a4-80bc-8006-c2b96872319a",
  },
  "text-styles": {
    file: "render-wasm/get-file-text-styles.json",
    fileId: "6bd7c17d-4f59-815e-8006-5c2559af4939",
    pageId: "6bd7c17d-4f59-815e-8006-5c2559af493a",
  },
};

const FIXTURE_NAME = process.env.PENPOT_PERF_FIXTURE || "texts-shadows";
const {
  file: FIXTURE,
  fileId: FILE_ID,
  pageId: PAGE_ID,
} = FIXTURES[FIXTURE_NAME] ?? FIXTURES["texts-shadows"];

const DEFAULT_DOUBLINGS = 6;
const RENDER_TIMEOUT_MS = 20000;
const BUILD_SETTLE_MS = 500;

function readDoublings() {
  const raw = process.env.PENPOT_PERF_DOUBLINGS;
  if (raw === undefined || raw === "") {
    return DEFAULT_DOUBLINGS;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `PENPOT_PERF_DOUBLINGS must be a non-negative integer, got "${raw}"`,
    );
  }
  return value;
}

async function waitForRenderAfter(page, previousCount) {
  try {
    await page.waitForFunction(
      (count) => (window.wasmRenderCount || 0) > count,
      previousCount,
      { timeout: RENDER_TIMEOUT_MS },
    );
  } catch (_error) {
    console.warn(`no render seen after duplicate (count ${previousCount})`);
  }
}

/**
 * Builds a large page with the app itself: select all, duplicate, repeat.
 */
async function buildLargePage(page, workspace, doublings) {
  for (let i = 0; i < doublings; i++) {
    const { box } = await viewportCentre(workspace);
    // Click near the corner of the viewport to focus the canvas.
    await page.mouse.click(box.x + 20, box.y + 20);
    const before = await workspace.getRenderCount();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+D");
    await waitForRenderAfter(page, before);
    await page.waitForTimeout(BUILD_SETTLE_MS);
  }

  await page.keyboard.press("Escape");
  await workspace.hideUI();
  await applyZoom(page, workspace, ["Shift+1"]);
}

async function openLargePage(page, { doublings }) {
  await WasmWorkspacePage.init(page);
  await WasmWorkspacePage.mockConfigFlags(page, [
    "enable-feature-render-wasm",
    "enable-render-wasm-dpr",
  ]);
  // Opening a wasm workspace backfills :position-data for text shapes, persisting the file.
  await WasmWorkspacePage.mockRPC(
    page,
    "update-file?id=*",
    "text-editor/update-file.json",
  );

  const workspace = new WasmWorkspacePage(page);
  await workspace.setupEmptyFile();
  await workspace.mockGetFile(FIXTURE);
  await workspace.goToWorkspace({ fileId: FILE_ID, pageId: PAGE_ID });
  // The UI is hidden once the page is built (buildLargePage); hideUI toggles.
  await workspace.waitForFirstRender();

  await installInstrumentation(page);
  await buildLargePage(page, workspace, doublings);
  return workspace;
}

test.describe("render-wasm navigation benchmark", () => {
  test.skip(!process.env.PENPOT_PERF, "perf benchmark; set PENPOT_PERF=1");
  test.describe.configure({ mode: "serial" });

  test("measures pan, zoom and fit on a large page", async ({ page }) => {
    test.setTimeout(15 * 60 * 1000);

    const startedAt = new Date().toISOString();
    const doublings = readDoublings();
    const workspace = await openLargePage(page, { doublings });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const viewport = page.viewportSize();
    const deviceScaleFactor = await page.evaluate(
      () => window.devicePixelRatio,
    );
    const gpuRenderer = await readGpuRenderer(page);

    const scenarios = [];

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

    const result = {
      startedAt,
      userAgent,
      viewport,
      deviceScaleFactor,
      doublings,
      gpuRenderer,
      fixture: FIXTURE,
      scenarios,
    };

    const file = writeResult(result);
    printSummary(scenarios);
    console.log(`perf results written to ${file}`);

    expect(scenarios.length).toBeGreaterThan(0);
  });
});
