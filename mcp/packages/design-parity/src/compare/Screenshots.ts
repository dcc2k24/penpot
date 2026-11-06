import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PIXEL_VIEWPORT } from "../Targets.js";

const execFileAsync = promisify(execFile);

/** Name of the exporter container that runs the Chromium of the pixel step in docker mode. */
export const EXPORTER_CONTAINER = "penpot-mcp-exporter";

/** Folder inside the container where a run keeps its worker script, targets and output. */
export const WORKER_REMOTE_DIR = "/tmp/design-parity";

/** Milliseconds a docker command may run before it is stopped. */
const DOCKER_TIMEOUT_MS = 20 * 60 * 1000;

/** Milliseconds the container check may run before it counts as not running. */
const INSPECT_TIMEOUT_MS = 30 * 1000;

/** Smallest device scale of a container screenshot. */
const MIN_SHOT_SCALE = 1;

/** Largest device scale of a container screenshot. */
const MAX_SHOT_SCALE = 3;

/** Where the app is screenshotted: in this Node process with the host Chromium, or in a container. */
export type AppBrowser = { mode: "local" } | { mode: "docker"; container: string };

/** One board to screenshot in the container. */
export interface ShotRequest {
    /** Position of the target in the compare run. Unique within one run. */
    index: number;
    /** Route of the app page, for example "/onboarding/welcome". */
    route: string;
    /** Id of the board node, read from its data-node-id attribute. */
    nodeId: string;
    /** Device scale of the page, an integer from 1 to 3. */
    scale: number;
    /** Pixels added on every side of the board box, a non-negative integer. */
    expand: number;
}

/** Paths inside the container that belong to one run. Forward slashes, POSIX form. */
export interface WorkerPaths {
    /** Folder of the run. */
    dir: string;
    /** Worker script. */
    script: string;
    /** Targets JSON file. */
    targets: string;
    /** Output folder, which holds the PNG files and result.json. */
    out: string;
}

/** Argument arrays of the docker commands of one run. Each one goes to execFile("docker", args). */
export interface DockerCommands {
    /** Creates the run folder in the container. */
    mkdir: string[];
    /** Copies the worker script into the container. */
    copyScript: string[];
    /** Copies the targets JSON into the container. */
    copyTargets: string[];
    /** Runs the worker script in the container. */
    exec: string[];
    /** Copies the output folder out of the container. */
    copyOut: string[];
    /** Removes the run folder from the container. */
    cleanup: string[];
}

/** Input of runDockerShots. */
export interface DockerShotsArgs {
    /** Name of the running container. */
    container: string;
    /** Base URL of the app as the container reaches it. */
    baseUrl: string;
    /** Boards to screenshot. */
    requests: ShotRequest[];
    /** Id of the run, from newRunId. */
    runId: string;
    /** Local folder for the script, the targets JSON and the output. */
    scratchDir: string;
}

/** One entry of result.json written by the worker. */
interface WorkerResult {
    /** Position of the target in the run. */
    index: number;
    /** True when the PNG was written. */
    ok: boolean;
    /** Why the screenshot failed, set when ok is false. */
    error?: string;
}

/**
 * Parses the value of the --app-browser option.
 *
 * @param spec - "local" or "docker:<container>", where the container name is not empty and has no spaces
 * @returns the parsed app browser
 * @throws Error when the value is neither form, and the message names the value
 */
export function parseAppBrowser(spec: string): AppBrowser {
    if (spec === "local") {
        return { mode: "local" };
    }
    const prefix = "docker:";
    if (spec.startsWith(prefix)) {
        const container = spec.slice(prefix.length);
        if (container.length > 0 && !/\s/.test(container)) {
            return { mode: "docker", container };
        }
    }
    throw new Error(`invalid app browser "${spec}": use "local" or "docker:<container>"`);
}

/**
 * Chooses the app browser when the option is absent: the exporter container when it runs, else the local browser.
 *
 * @param containerRunning - true when the exporter container is running
 * @returns the docker browser of the exporter container, or the local browser
 */
export function defaultAppBrowser(containerRunning: boolean): AppBrowser {
    if (containerRunning) {
        return { mode: "docker", container: EXPORTER_CONTAINER };
    }
    return { mode: "local" };
}

/**
 * Builds a new run id from the clock and a random suffix, so that two runs do not share a folder.
 *
 * @returns the run id, for example "1767225600000-9f3a6c1e"
 */
export function newRunId(): string {
    return `${Date.now()}-${randomBytes(4).toString("hex")}`;
}

/**
 * Builds the paths inside the container for one run.
 *
 * @param runId - id of the run
 * @returns the run folder, the worker script, the targets file and the output folder
 */
export function workerPaths(runId: string): WorkerPaths {
    const dir = WORKER_REMOTE_DIR + "/" + runId;
    return { dir, script: dir + "/worker.mjs", targets: dir + "/targets.json", out: dir + "/out" };
}

/**
 * Builds the targets JSON that the worker reads.
 *
 * @param baseUrl - base URL of the app as the container reaches it
 * @param requests - boards to screenshot
 * @returns the JSON text with the keys baseUrl and requests
 * @throws Error when a scale is not an integer from 1 to 3, when an expand is not a non-negative integer, or when
 *   two requests share an index
 */
export function buildTargetsJson(baseUrl: string, requests: ShotRequest[]): string {
    const seen = new Set<number>();
    for (const request of requests) {
        if (!Number.isInteger(request.scale) || request.scale < MIN_SHOT_SCALE || request.scale > MAX_SHOT_SCALE) {
            throw new Error(`scale must be an integer from 1 to 3, found ${request.scale} for index ${request.index}`);
        }
        if (!Number.isInteger(request.expand) || request.expand < 0) {
            throw new Error(
                `expand must be a non-negative integer, found ${request.expand} for index ${request.index}`
            );
        }
        if (!Number.isInteger(request.index)) {
            throw new Error(`index must be an integer, found ${request.index}`);
        }
        if (seen.has(request.index)) {
            throw new Error(`duplicate request index ${request.index}`);
        }
        seen.add(request.index);
    }
    return JSON.stringify({ baseUrl, requests }, null, 2);
}

/**
 * Returns the source of the worker script that runs inside the container. It is a plain Node ES module, not
 * TypeScript. It takes the targets file and the output folder as arguments, screenshots each board in its own page,
 * and writes one PNG per request plus result.json. A failure on one request does not stop the others.
 *
 * @returns the script text
 */
export function workerSource(): string {
    return `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { chromium } = await import("/opt/penpot/exporter/node_modules/playwright/index.mjs");
const targetsFile = process.argv[2];
const outDir = process.argv[3];
mkdirSync(outDir, { recursive: true });
const { baseUrl, requests } = JSON.parse(readFileSync(targetsFile, "utf8"));
const results = [];
const browser = await chromium.launch({ headless: true, args: ["--disable-lcd-text"] });
try {
    for (const request of requests) {
        let page = null;
        try {
            page = await browser.newPage({
                viewport: { width: ${PIXEL_VIEWPORT.width}, height: ${PIXEL_VIEWPORT.height} },
                deviceScaleFactor: request.scale,
            });
            const url = baseUrl + request.route;
            try {
                await page.goto(url, { waitUntil: "networkidle" });
            } catch {
                await page.goto(url, { waitUntil: "load" });
            }
            const selector = '[data-node-id="' + request.nodeId + '"]';
            await page.waitForSelector(selector, { timeout: 15000 });
            await page.evaluate(() => document.fonts.ready);
            const rect = await page.evaluate((sel) => {
                const box = document.querySelector(sel).getBoundingClientRect();
                return { x: box.left, y: box.top, width: box.width, height: box.height };
            }, selector);
            const e = request.expand;
            const png = await page.screenshot({
                clip: { x: rect.x - e, y: rect.y - e, width: rect.width + 2 * e, height: rect.height + 2 * e },
                fullPage: false,
            });
            writeFileSync(join(outDir, request.index + ".png"), png);
            results.push({ index: request.index, ok: true });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            results.push({ index: request.index, ok: false, error: message });
        } finally {
            if (page !== null) {
                await page.close().catch(() => {});
            }
        }
    }
} finally {
    await browser.close();
}
writeFileSync(join(outDir, "result.json"), JSON.stringify(results));
`;
}

/**
 * Builds the docker command arrays of one run.
 *
 * @param container - name of the running container
 * @param paths - paths inside the container, from workerPaths
 * @param localScript - local path of the worker script
 * @param localTargets - local path of the targets JSON
 * @param localOutParent - local folder that receives the output folder
 * @returns one argument array per docker step, each for execFile("docker", args)
 */
export function dockerArgs(
    container: string,
    paths: WorkerPaths,
    localScript: string,
    localTargets: string,
    localOutParent: string
): DockerCommands {
    return {
        mkdir: ["exec", container, "mkdir", "-p", paths.dir],
        copyScript: ["cp", localScript, container + ":" + paths.script],
        copyTargets: ["cp", localTargets, container + ":" + paths.targets],
        exec: ["exec", container, "node", paths.script, paths.targets, paths.out],
        copyOut: ["cp", container + ":" + paths.out, localOutParent],
        cleanup: ["exec", container, "rm", "-rf", paths.dir],
    };
}

/**
 * Runs one docker command with a timeout.
 *
 * @param args - argument array for docker
 * @returns the standard output of the command
 * @throws Error when the command fails, with its standard error in the message
 */
async function runDocker(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("docker", args, { timeout: DOCKER_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
}

/**
 * Screenshots the boards in the container and returns the PNG of each board that succeeded.
 *
 * It writes the worker script and the targets JSON into scratchDir, creates the run folder in the container, copies
 * the files in, runs the worker, copies the output folder back and reads it. The run folder is removed in a finally
 * block. A failed request is left out of the result and logged with console.log. A failed docker step throws.
 *
 * @param args - container, base URL, requests, run id and local scratch folder
 * @returns the PNG buffers of the successful requests, by request index
 * @throws Error when a docker step fails, or when the worker wrote no result.json
 */
export async function runDockerShots(args: DockerShotsArgs): Promise<Map<number, Buffer>> {
    const { container, requests, runId, scratchDir } = args;
    mkdirSync(scratchDir, { recursive: true });
    const localScript = join(scratchDir, "worker.mjs");
    const localTargets = join(scratchDir, "targets.json");
    const localOut = join(scratchDir, "out");
    // a stale output folder would hide a failed run, so it goes before the new run writes its files.
    rmSync(localOut, { recursive: true, force: true });
    writeFileSync(localScript, workerSource());
    writeFileSync(localTargets, buildTargetsJson(args.baseUrl, requests));

    const paths = workerPaths(runId);
    const commands = dockerArgs(container, paths, localScript, localTargets, scratchDir);
    const shots = new Map<number, Buffer>();
    try {
        await runDocker(commands.mkdir);
        await runDocker(commands.copyScript);
        await runDocker(commands.copyTargets);
        await runDocker(commands.exec);
        await runDocker(commands.copyOut);
        const resultFile = join(localOut, "result.json");
        if (!existsSync(resultFile)) {
            throw new Error("the container screenshot run wrote no result.json");
        }
        const results = JSON.parse(readFileSync(resultFile, "utf8")) as WorkerResult[];
        for (const result of results) {
            if (!result.ok) {
                console.log(`[pixel] docker screenshot failed for index ${result.index}: ${result.error ?? "unknown"}`);
                continue;
            }
            const pngFile = join(localOut, `${result.index}.png`);
            if (existsSync(pngFile)) {
                shots.set(result.index, readFileSync(pngFile));
            }
        }
    } finally {
        try {
            await runDocker(commands.cleanup);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`[pixel] could not remove ${paths.dir} in ${container}: ${message}`);
        }
    }
    return shots;
}

/**
 * Tells whether the container runs. Any error counts as not running.
 *
 * @param container - name of the container
 * @returns true when docker reports the container as running
 */
export async function containerRunning(container: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync("docker", ["inspect", "--format", "{{.State.Running}}", container], {
            timeout: INSPECT_TIMEOUT_MS,
        });
        return stdout.trim() === "true";
    } catch {
        return false;
    }
}
