import { existsSync, readFileSync } from "node:fs";
import type { DesignModel, NodeModel } from "./DesignModel.js";
import { DesignBuilder, type BuildReport } from "./DesignBuilder.js";
import { DESIGN_SPEC } from "./DesignSpec.js";
import { IdsStore } from "./IdsStore.js";
import { McpSession } from "./McpSession.js";
import { DesignPuller } from "./Puller.js";
import { DESIGN_FILE, KNOWN_GAPS_FILE, MCP_URL, tokenFilePath, varsFilePath } from "./Paths.js";
import { DesignVerifier } from "./Verifier.js";
import { runGenerate } from "./generate/GenerateCommand.js";
import { compareExitCode, DEFAULT_SCALE, MAX_SCALE, MIN_SCALE, runCompare } from "./compare/CompareCommand.js";
import { DEFAULT_PIXEL_BUDGETS, parseBudgetOption, type PixelBudgets } from "./compare/Budget.js";
import { containerRunning, defaultAppBrowser, EXPORTER_CONTAINER, parseAppBrowser } from "./compare/Screenshots.js";
import { runLoop } from "./LoopCommand.js";

/** Exit code of a build that failed, or of a command line that is wrong. */
const EXIT_FAILURE = 1;

/**
 * Reads the MCP token from its file. The token is returned to the caller only and never printed.
 *
 * @throws Error when the file is missing or empty
 */
function readToken(): string {
    const tokenFile = tokenFilePath();
    if (!existsSync(tokenFile)) {
        throw new Error(`token file not found: ${tokenFile}`);
    }
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token === "") {
        throw new Error(`token file is empty: ${tokenFile}`);
    }
    return token;
}

/**
 * Reads the project id from the vars file.
 *
 * @throws Error when the file is missing or has no projectId
 */
function readProjectId(): string {
    const varsFile = varsFilePath();
    if (!existsSync(varsFile)) {
        throw new Error(`vars file not found: ${varsFile}`);
    }
    const parsed: unknown = JSON.parse(readFileSync(varsFile, "utf8"));
    const projectId =
        typeof parsed === "object" && parsed !== null ? (parsed as { projectId?: unknown }).projectId : undefined;
    if (typeof projectId !== "string") {
        throw new Error(`vars file has no projectId: ${varsFile}`);
    }
    return projectId;
}

/**
 * Counts the known gaps listed in KNOWN_GAPS.md. Each gap is a heading that starts with its number.
 */
function countKnownGaps(): number {
    if (!existsSync(KNOWN_GAPS_FILE)) {
        return 0;
    }
    return readFileSync(KNOWN_GAPS_FILE, "utf8")
        .split("\n")
        .filter((line) => /^### \d+\./.test(line)).length;
}

/**
 * Prints the summary table of a finished build.
 *
 * @param report - the build report
 */
function printSummary(report: BuildReport): void {
    const lines: string[] = [];
    lines.push("");
    lines.push("=== Design Lab build summary ===");
    lines.push(`file id      ${report.fileId}`);
    lines.push("pages:");
    for (const [name, id] of Object.entries(report.pages)) {
        lines.push(`  ${name.padEnd(28)} ${id}  nodes ${report.nodeCounts[name] ?? 0}`);
    }
    lines.push("batches:");
    for (const batch of report.batches) {
        lines.push(
            `  ${batch.label.padEnd(48)} ${String(batch.ops).padStart(4)} ops ${String(batch.ms).padStart(6)} ms  revn ${batch.revn ?? "?"}`
        );
    }
    lines.push(`total        ${Math.round(report.totalMs)} ms`);
    lines.push(`known gaps   ${countKnownGaps()} (see ${KNOWN_GAPS_FILE})`);
    console.log(lines.join("\n"));
}

/**
 * Runs the build. `--reset` is accepted for compatibility; a build always starts from a new file.
 *
 * @returns the process exit code
 */
async function runBuild(): Promise<number> {
    let session: McpSession | undefined = undefined;
    try {
        session = new McpSession(MCP_URL, readToken());
        await session.connect();
        const projectId = readProjectId();
        const report = await new DesignBuilder(session, new IdsStore()).build(projectId);
        printSummary(report);
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`build failed: ${message}`);
        return EXIT_FAILURE;
    } finally {
        await session?.close();
    }
}

/**
 * Counts the nodes of a list and of every descendant. The nodes of the list are counted too.
 *
 * @param nodes - nodes to count
 */
function countNodes(nodes: readonly NodeModel[]): number {
    return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/**
 * Prints the summary of a finished pull: one line per page, then the total.
 *
 * @param model - the pulled model
 * @param ms - duration of the pull in milliseconds
 */
function printPullSummary(model: DesignModel, ms: number): void {
    const lines: string[] = [];
    let total = 0;
    for (const page of model.pages) {
        const count = countNodes(page.boards);
        total += count;
        lines.push(`  ${page.name.padEnd(28)} nodes ${count}`);
    }
    lines.push(`pulled ${total} nodes into ${DESIGN_FILE} in ${Math.round(ms)} ms`);
    console.log(lines.join("\n"));
}

/**
 * Runs the pull. It reads the file recorded by the last build and writes design.json.
 *
 * @returns the process exit code
 */
async function runPull(): Promise<number> {
    const fileId = IdsStore.readRecordedFileId();
    if (fileId === undefined) {
        console.error("pull failed: no file recorded. Run build first.");
        return EXIT_FAILURE;
    }
    let session: McpSession | undefined = undefined;
    const started = performance.now();
    try {
        session = new McpSession(MCP_URL, readToken());
        await session.connect();
        const model = await new DesignPuller(session, fileId).pull();
        printPullSummary(model, performance.now() - started);
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`pull failed: ${message}`);
        return EXIT_FAILURE;
    } finally {
        await session?.close();
    }
}

/**
 * Runs the verifier on design.json and prints its report.
 *
 * @returns the process exit code, 1 when a check failed
 */
function runVerify(): number {
    if (!existsSync(DESIGN_FILE)) {
        console.error("run pull first");
        return EXIT_FAILURE;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(DESIGN_FILE, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`verify failed: ${message}`);
        return EXIT_FAILURE;
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { formatVersion?: unknown }).formatVersion !== 1) {
        console.error("verify failed: design.json has an unknown format version");
        return EXIT_FAILURE;
    }
    try {
        const report = new DesignVerifier(DESIGN_SPEC, parsed as DesignModel).run();
        console.log(DesignVerifier.format(report));
        return report.failed > 0 ? EXIT_FAILURE : 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`verify failed: ${message}`);
        return EXIT_FAILURE;
    }
}

/**
 * Parses the options of the compare command and runs it. The exit code is 1 when the DOM compare has any mismatch, or
 * when a target is over its pixel budget or could not be compared. `--advisory` leaves the pixel results out of the
 * exit code.
 *
 * @param args - command line options after the command name
 * @returns the process exit code
 */
async function runCompareCommand(args: string[]): Promise<number> {
    let screen: string | undefined = undefined;
    let pixel = true;
    let scale: number = DEFAULT_SCALE;
    let appBrowserSpec: string | undefined = undefined;
    let advisory = false;
    const budgets: PixelBudgets = { ...DEFAULT_PIXEL_BUDGETS };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--no-pixel") {
            pixel = false;
        } else if (arg === "--advisory") {
            advisory = true;
        } else if (arg === "--pixel-budget-components" && args[index + 1] !== undefined) {
            budgets.component = parseBudgetOption(args[index + 1], "--pixel-budget-components");
            index++;
        } else if (arg === "--pixel-budget-screens" && args[index + 1] !== undefined) {
            budgets.screen = parseBudgetOption(args[index + 1], "--pixel-budget-screens");
            index++;
        } else if (arg === "--screen" && args[index + 1] !== undefined) {
            screen = args[index + 1];
            index++;
        } else if (arg === "--app-browser" && args[index + 1] !== undefined) {
            appBrowserSpec = args[index + 1];
            index++;
        } else if (arg === "--scale" && args[index + 1] !== undefined) {
            const value = args[index + 1];
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed < MIN_SCALE || parsed > MAX_SCALE) {
                console.error(`invalid value for --scale: ${value}, use an integer from ${MIN_SCALE} to ${MAX_SCALE}`);
                return EXIT_FAILURE;
            }
            scale = parsed;
            index++;
        } else {
            console.error(`unknown option for compare: ${arg}`);
            return EXIT_FAILURE;
        }
    }
    try {
        // without the option, the pixel step uses the exporter container when it runs, as the export does.
        const appBrowser =
            appBrowserSpec !== undefined
                ? parseAppBrowser(appBrowserSpec)
                : defaultAppBrowser(pixel && (await containerRunning(EXPORTER_CONTAINER)));
        const outcome = await runCompare({ screen, pixel, scale, appBrowser, budgets });
        return compareExitCode(outcome, advisory);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`compare failed: ${message}`);
        return EXIT_FAILURE;
    }
}

/**
 * Parses the options of the loop command and runs it. The exit code is 1 when mismatches remain or a run fails. Without
 * `--all` the loop compares only the targets that failed in the last report.
 *
 * @param args - command line options after the command name
 * @returns the process exit code
 */
async function runLoopCommand(args: string[]): Promise<number> {
    let max = 5;
    let all = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === "--all") {
            all = true;
        } else if (arg === "--max" && args[index + 1] !== undefined) {
            const value = args[index + 1];
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                console.error(`invalid value for --max: ${value}`);
                return EXIT_FAILURE;
            }
            max = parsed;
            index++;
        } else {
            console.error(`unknown option for loop: ${arg}`);
            return EXIT_FAILURE;
        }
    }
    try {
        const code = await runLoop(max, all);
        return code;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`loop failed: ${message}`);
        return EXIT_FAILURE;
    }
}

/**
 * Entry point. Routes the command line to its command.
 */
async function main(): Promise<number> {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
        case "build":
            if (rest.some((arg) => arg !== "--reset")) {
                console.error(`unknown option for build: ${rest.join(" ")}`);
                return EXIT_FAILURE;
            }
            return runBuild();
        case "pull":
            if (rest.length > 0) {
                console.error(`unknown option for pull: ${rest.join(" ")}`);
                return EXIT_FAILURE;
            }
            return runPull();
        case "verify":
            if (rest.length > 0) {
                console.error(`unknown option for verify: ${rest.join(" ")}`);
                return EXIT_FAILURE;
            }
            return runVerify();
        case "generate":
            if (rest.length > 0) {
                console.error(`unknown option for generate: ${rest.join(" ")}`);
                return EXIT_FAILURE;
            }
            return runGenerate();
        case "compare":
            return runCompareCommand(rest);
        case "loop":
            return runLoopCommand(rest);
        default:
            console.error(
                "usage: tsx src/index.ts build [--reset] | pull | verify | generate | compare [--screen <name>] [--scale <1-3>] [--no-pixel] [--app-browser local|docker:<container>] | loop [--max <n>] [--all]"
            );
            return EXIT_FAILURE;
    }
}

process.exitCode = await main();
