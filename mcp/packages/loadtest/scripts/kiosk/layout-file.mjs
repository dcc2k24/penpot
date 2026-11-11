/**
 * Opens a file in the workspace of a headless browser so that the browser lays out the texts and Penpot saves their
 * `positionData`. The sign-in follows scripts/human-tab/human-tab.mjs. The password comes from the environment
 * variable PENPOT_HUMAN_PASSWORD, or from the file named by PENPOT_HUMAN_PASSWORD_FILE. It is never printed.
 */
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

/**
 * Signs in to the frontend.
 *
 * @param {import("playwright").Page} page - browser page
 * @param {string} frontend - frontend origin
 * @param {string} email - account
 * @param {string} password - password
 */
async function signIn(page, frontend, email, password) {
    await page.goto(`${frontend}/#/auth/login`, { waitUntil: "domcontentloaded", timeout: 120000 });
    const emailInput = page.locator('input[name="email"]');
    await emailInput.waitFor({ state: "visible", timeout: 120000 });
    const passwordInput = page.locator('input[name="password"]');
    if (!(await passwordInput.isVisible().catch(() => false))) {
        await page
            .getByText(/log ?in with password|password/i)
            .first()
            .click({ timeout: 10000 });
        await passwordInput.waitFor({ state: "visible", timeout: 30000 });
    }
    await emailInput.fill(email);
    await passwordInput.fill(password);
    await page.locator('button[type="submit"]').first().click();
    // the frontend routes by hash (#/dashboard/...) or by query string (?screen=dashboard-recent)
    await page.waitForFunction(
        () => {
            const screen = new URLSearchParams(location.search).get("screen");
            return (
                (location.hash !== "" && !location.hash.startsWith("#/auth")) ||
                (!!screen && !screen.startsWith("auth"))
            );
        },
        null,
        { timeout: 120000 }
    );
}

/**
 * Opens a page of a file in the workspace, waits, and closes the browser. Never clicks an export control.
 *
 * @param {object} options - settings
 * @param {string} options.fileId - file id
 * @param {string} options.pageId - page to open
 * @param {string} options.teamId - team id
 * @param {string} options.projectId - project id
 * @param {() => Promise<boolean>} [options.isDone] - polled every 5 s; true once the texts are laid out
 * @param {number} [options.timeoutMs] - longest wait for `isDone` (default 15 minutes)
 * @param {string} [options.frontend] - frontend origin
 * @param {string} [options.email] - account
 * @param {(line: string) => void} [options.log] - progress lines
 * @returns {Promise<{openMs: number, waitMs: number, done: boolean}>} time to the canvas, time waited, and whether
 *   `isDone` answered true
 */
export async function layoutFile(options) {
    const frontend = options.frontend ?? "http://localhost:9003";
    const email = options.email ?? "mcpdev@example.com";
    const log = options.log ?? (() => {});
    const password =
        process.env.PENPOT_HUMAN_PASSWORD ??
        (process.env.PENPOT_HUMAN_PASSWORD_FILE
            ? (await readFile(process.env.PENPOT_HUMAN_PASSWORD_FILE, "utf8")).trim()
            : "");
    if (password === "") {
        throw new Error("set PENPOT_HUMAN_PASSWORD or PENPOT_HUMAN_PASSWORD_FILE");
    }
    const browser = await chromium.launch({
        headless: true,
        args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"],
    });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await signIn(page, frontend, email, password);
        const params = new URLSearchParams({
            "team-id": options.teamId,
            "project-id": options.projectId,
            "file-id": options.fileId,
            "page-id": options.pageId,
        });
        const started = Date.now();
        await page.goto(`${frontend}/#/workspace?${params.toString()}`, {
            waitUntil: "domcontentloaded",
            timeout: 120000,
        });
        await page.waitForSelector('.viewport, [class*="workspace_viewport__viewport"]', { timeout: 300000 });
        const openMs = Date.now() - started;
        log(`  workspace open after ${openMs} ms`);
        const waited = Date.now();
        const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
        let done = options.isDone === undefined;
        while (!done && Date.now() - waited < timeoutMs) {
            await page.waitForTimeout(5000);
            done = await options.isDone();
        }
        // Penpot saves a change about 3 s after it happens
        await page.waitForTimeout(6000);
        return { openMs, waitMs: Date.now() - waited, done };
    } finally {
        await browser.close();
    }
}

/**
 * Opens a built kiosk file in the browser and waits until the texts of a few screens spread over the Journeys page
 * hold `positionData`. The result says how long it took, or why it did not finish.
 *
 * @param {object} options - settings
 * @param {(tool: string, toolArgs: Record<string, unknown>) => Promise<{json?: any}>} options.call - tool caller
 * @param {string} options.fileId - file id
 * @param {string} options.projectId - project id
 * @param {string} options.journeysPage - id of the Journeys page
 * @param {string[]} options.screenIds - ids of the screen frames, in page order
 * @param {number} [options.timeoutMs] - longest wait for the layout after the workspace opens
 * @param {(line: string) => void} [options.log] - progress lines
 */
export async function layoutKiosk(options) {
    const { call, fileId, journeysPage } = options;
    const picks = [0, 0.25, 0.5, 0.75, 0.999].map((f) => options.screenIds[Math.floor(f * options.screenIds.length)]);
    const textsLaidOut = async () => {
        let texts = 0;
        let laid = 0;
        for (const rootId of picks) {
            let cursor;
            do {
                const r = await call("export_subtree", {
                    fileId,
                    pageId: journeysPage,
                    rootId,
                    ...(cursor ? { cursor } : {}),
                });
                for (const shape of r.json?.shapes ?? []) {
                    if (shape.type === "text") {
                        texts++;
                        laid += Array.isArray(shape.positionData) && shape.positionData.length > 0 ? 1 : 0;
                    }
                }
                cursor = r.json?.truncated ? r.json.nextCursor : undefined;
            } while (cursor);
        }
        return texts > 0 && laid === texts;
    };
    const started = performance.now();
    try {
        const opened = await layoutFile({
            fileId,
            projectId: options.projectId,
            teamId: (await call("get_file_outline", { fileId })).json.teamId,
            pageId: journeysPage,
            isDone: textsLaidOut,
            timeoutMs: options.timeoutMs,
            log: options.log,
        });
        return { ...opened, seconds: Number(((performance.now() - started) / 1000).toFixed(1)) };
    } catch (error) {
        const firstLine = String(error.message ?? error).split(/\r?\n/)[0];
        return { done: false, error: firstLine, seconds: Number(((performance.now() - started) / 1000).toFixed(1)) };
    }
}
