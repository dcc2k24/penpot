import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";

/** A check on the parsed result of a call. Placeholders in it are resolved before the check runs. */
export interface ScenarioExpectation {
    /** JSONPath of the value to check, evaluated against { result: parsed tool output }. */
    path: string;
    /** Value the path must equal. */
    equals?: unknown;
    /** Length the value must have when it is an array or a string. A placeholder must resolve to a whole number. */
    length?: number | string;
    /** Largest length the value may have when it is an array or a string. A placeholder must resolve to a whole number. */
    maxLength?: number | string;
    /** Sum that the value must have when it is an array of numbers. A placeholder must resolve to a whole number. */
    sum?: number | string;
    /** Value that at least one element of the array must equal, compared as JSON. */
    contains?: unknown;
}

/** One tool call template of a scenario. */
export interface ScenarioStep {
    /** Label of the step in reports. Defaults to the tool name. */
    name: string;
    /** MCP tool name, for example apply_operations. */
    tool: string;
    /** Tool arguments, with ${name} placeholders and $repeat directives. */
    args: Record<string, unknown>;
    /** Number of consecutive calls of this step per agent, or a placeholder that resolves to such a number. */
    repeat: number | string;
    /** Maximum calls per second for each agent, applied to this step. */
    rateLimitPerSecond?: number;
    /** Variables to set from the parsed result, keyed by variable name, with JSONPath values. */
    capture: Record<string, string>;
    /** Checks of the parsed result. All must pass, and the first failure is recorded as the error of the call. */
    expect?: ScenarioExpectation[];
    /**
     * Regular expression source, compiled case-insensitive. The call must fail and its failure text must match. A
     * matching failure counts as a success. A step with expectError has no capture and no expect.
     */
    expectError?: string;
    /** Longest allowed duration in milliseconds of a successful call or of a matching expected error. */
    maxDurationMs?: number;
    /** Minimum time in milliseconds between two runs of this step by one agent. A run that comes sooner is skipped. */
    everyMs?: number;
}

/** A load scenario: an ordered list of tool calls that each simulated agent runs. */
export interface Scenario {
    /** Name used in result files, for example S1-create-pages. */
    name: string;
    /** Human-readable summary of the scenario and the plan item it covers. */
    description: string;
    /** Default number of simulated agents. The command line overrides it. */
    agents: number;
    /** Number of times each agent runs the step list when no duration is given. */
    iterations: number;
    /** True when the file asked for a fresh page. The step that creates the page is the first entry of setup. */
    freshPage: boolean;
    /** Steps run before each iteration, or before the first iteration of each agent (see setupPer). */
    setup: ScenarioStep[];
    /** When setup runs: "iteration" before every iteration (the default), or "agent" only before the first one. */
    setupPer: "iteration" | "agent";
    /** Steps, run in order by every agent. */
    steps: ScenarioStep[];
}

/**
 * Reads scenario files and checks their shape.
 */
export class ScenarioLoader {
    /** Directory of the bundled scenario fixtures. */
    static readonly FIXTURE_DIRECTORY = new URL("../fixtures/scenarios/", import.meta.url);

    /**
     * Loads a scenario by fixture name or by file path.
     *
     * @param nameOrPath - name of a bundled fixture such as s1-create-pages, or a path to a JSON file
     * @throws Error when the scenario cannot be found or is invalid
     */
    static async load(nameOrPath: string): Promise<Scenario> {
        const file = ScenarioLoader.locate(nameOrPath);
        const text = await readFile(file, "utf8");
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch (error) {
            throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
        }
        return ScenarioLoader.parse(json, file);
    }

    /**
     * Lists the names of the bundled fixtures.
     */
    static async listFixtures(): Promise<string[]> {
        const names = await readdir(fileURLToPath(ScenarioLoader.FIXTURE_DIRECTORY));
        return names
            .filter((name) => name.endsWith(".json"))
            .map((name) => basename(name, ".json"))
            .sort();
    }

    /**
     * Finds the file of a scenario, looking first at the path as given and then in the fixture directory.
     *
     * @param nameOrPath - fixture name or path
     * @throws Error when neither exists
     */
    static locate(nameOrPath: string): string {
        if (existsSync(nameOrPath)) {
            return resolve(nameOrPath);
        }
        const fixture = fileURLToPath(new URL(`${nameOrPath}.json`, ScenarioLoader.FIXTURE_DIRECTORY));
        if (existsSync(fixture)) {
            return fixture;
        }
        throw new Error(`no scenario "${nameOrPath}": give a fixture name or a path to a JSON file`);
    }

    /**
     * Checks a parsed scenario document and fills in defaults. A freshPage option becomes the first setup step, in
     * front of the setup steps of the file.
     *
     * @param json - parsed JSON document
     * @param source - file name used in error messages
     * @throws Error listing the first problem found
     */
    static parse(json: unknown, source: string): Scenario {
        const root = ScenarioLoader.objectOf(json, source);
        const steps = root.steps;
        if (!Array.isArray(steps) || steps.length === 0) {
            throw new Error(`${source}: steps must be a non-empty array`);
        }
        const name = ScenarioLoader.stringOf(root.name, `${source}: name`);
        const fileSetup = root.setup ?? [];
        if (!Array.isArray(fileSetup)) {
            throw new Error(`${source}: setup must be an array`);
        }
        const setup = fileSetup.map((step, index) => ScenarioLoader.parseStep(step, `${source}: setup[${index}]`));
        const freshPage =
            root.freshPage === undefined ? undefined : ScenarioLoader.freshPageStep(root.freshPage, name, source);
        return {
            name,
            description: typeof root.description === "string" ? root.description : "",
            agents: ScenarioLoader.positiveInteger(root.agents ?? 1, `${source}: agents`),
            iterations: ScenarioLoader.positiveInteger(root.iterations ?? 1, `${source}: iterations`),
            freshPage: freshPage !== undefined,
            setup: freshPage === undefined ? setup : [freshPage, ...setup],
            setupPer: ScenarioLoader.setupPerOf(root.setupPer, source),
            steps: steps.map((step, index) => ScenarioLoader.parseStep(step, `${source}: steps[${index}]`)),
        };
    }

    /**
     * Checks one step.
     *
     * @param value - parsed step
     * @param where - location used in error messages
     */
    private static parseStep(value: unknown, where: string): ScenarioStep {
        const step = ScenarioLoader.objectOf(value, where);
        const tool = ScenarioLoader.stringOf(step.tool, `${where}: tool`);
        const repeat = step.repeat ?? 1;
        if (typeof repeat !== "string") {
            ScenarioLoader.positiveInteger(repeat, `${where}: repeat`);
        } else if (!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(repeat)) {
            throw new Error(`${where}: a string repeat must be a placeholder such as "\${fileCount}"`);
        }
        const args = step.args ?? {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
            throw new Error(`${where}: args must be an object`);
        }
        const capture = step.capture ?? {};
        const captureObject = ScenarioLoader.objectOf(capture, `${where}: capture`);
        for (const [name, expression] of Object.entries(captureObject)) {
            if (typeof expression !== "string" || !expression.startsWith("$")) {
                throw new Error(`${where}: capture ${name} must be a JSONPath string starting with $`);
            }
        }
        let rateLimitPerSecond: number | undefined;
        if (step.rateLimitPerSecond !== undefined) {
            if (typeof step.rateLimitPerSecond !== "number" || !(step.rateLimitPerSecond > 0)) {
                throw new Error(`${where}: rateLimitPerSecond must be a positive number`);
            }
            rateLimitPerSecond = step.rateLimitPerSecond;
        }
        const expect = ScenarioLoader.parseExpectations(step.expect, where);
        let expectError: string | undefined;
        if (step.expectError !== undefined) {
            const source = ScenarioLoader.stringOf(step.expectError, `${where}: expectError`);
            if (Object.keys(captureObject).length > 0 || expect !== undefined) {
                throw new Error(`${where}: a step with expectError cannot also have capture or expect`);
            }
            try {
                new RegExp(source, "i");
            } catch (error) {
                throw new Error(`${where}: expectError is not a valid regular expression: ${(error as Error).message}`);
            }
            expectError = source;
        }
        const maxDurationMs =
            step.maxDurationMs === undefined
                ? undefined
                : ScenarioLoader.positiveNumber(step.maxDurationMs, `${where}: maxDurationMs`);
        const everyMs =
            step.everyMs === undefined ? undefined : ScenarioLoader.positiveNumber(step.everyMs, `${where}: everyMs`);
        return {
            name: typeof step.name === "string" ? step.name : tool,
            tool,
            args: args as Record<string, unknown>,
            repeat: repeat as number | string,
            rateLimitPerSecond,
            capture: captureObject as Record<string, string>,
            expect,
            expectError,
            maxDurationMs,
            everyMs,
        };
    }

    /**
     * Checks the optional expectations of a step. The value is one expectation object or an array of them.
     *
     * @param value - parsed expect value, or undefined
     * @param where - location used in error messages
     */
    private static parseExpectations(value: unknown, where: string): ScenarioExpectation[] | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                throw new Error(`${where}: expect must not be an empty array`);
            }
            return value.map((item, index) => ScenarioLoader.parseExpectation(item, `${where}: expect[${index}]`));
        }
        return [ScenarioLoader.parseExpectation(value, `${where}: expect`)];
    }

    /**
     * Checks one expectation object.
     *
     * @param value - parsed expectation
     * @param label - location used in error messages
     */
    private static parseExpectation(value: unknown, label: string): ScenarioExpectation {
        const expect = ScenarioLoader.objectOf(value, label);
        const path = ScenarioLoader.stringOf(expect.path, `${label}.path`);
        if (!path.startsWith("$")) {
            throw new Error(`${label}.path must be a JSONPath starting with $`);
        }
        const parsed: ScenarioExpectation = { path };
        if (expect.equals !== undefined) {
            parsed.equals = expect.equals;
        }
        if (expect.contains !== undefined) {
            parsed.contains = expect.contains;
        }
        if (expect.length !== undefined) {
            parsed.length = ScenarioLoader.countOrPlaceholder(expect.length, `${label}.length`);
        }
        if (expect.maxLength !== undefined) {
            parsed.maxLength = ScenarioLoader.countOrPlaceholder(expect.maxLength, `${label}.maxLength`);
        }
        if (expect.sum !== undefined) {
            parsed.sum = ScenarioLoader.countOrPlaceholder(expect.sum, `${label}.sum`);
        }
        return parsed;
    }

    /**
     * Builds the setup step that creates a fresh page for each agent and iteration.
     *
     * @param value - parsed freshPage value: true, or an object with optional fileId and name
     * @param scenarioName - name of the scenario, used in the default page name
     * @param source - file name used in error messages
     * @throws Error when the value has another shape
     */
    private static freshPageStep(value: unknown, scenarioName: string, source: string): ScenarioStep {
        const where = `${source}: freshPage`;
        let fileId: unknown = "${fileId}";
        let name: unknown = scenarioName + " ${runId} a${agent} i${iteration}";
        if (value !== true) {
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new Error(`${where} must be true or an object with optional fileId and name`);
            }
            const options = value as Record<string, unknown>;
            for (const key of Object.keys(options)) {
                if (key !== "fileId" && key !== "name") {
                    throw new Error(`${where}: unknown key ${key}, expected fileId or name`);
                }
            }
            if (options.fileId !== undefined) {
                fileId = ScenarioLoader.stringOf(options.fileId, `${where}.fileId`);
            }
            if (options.name !== undefined) {
                name = ScenarioLoader.stringOf(options.name, `${where}.name`);
            }
        }
        return ScenarioLoader.parseStep(
            {
                name: "fresh page",
                tool: "apply_operations",
                args: {
                    fileId,
                    snapshot: false,
                    operations: [{ op: "create_page", id: "$tmp:page", name }],
                },
                capture: { pageId: '$.result.createdIds["$tmp:page"]' },
            },
            `${where} step`
        );
    }

    /**
     * Reads the setupPer option.
     *
     * @param value - parsed setupPer value, or undefined
     * @param source - file name used in error messages
     * @throws Error when the value is neither "iteration" nor "agent"
     */
    private static setupPerOf(value: unknown, source: string): "iteration" | "agent" {
        if (value === undefined || value === "iteration") {
            return "iteration";
        }
        if (value === "agent") {
            return "agent";
        }
        throw new Error(`${source}: setupPer must be "iteration" or "agent"`);
    }

    /**
     * Returns a value as an object, or fails.
     *
     * @param value - parsed value
     * @param where - location used in error messages
     */
    private static objectOf(value: unknown, where: string): Record<string, unknown> {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`${where} must be an object`);
        }
        return value as Record<string, unknown>;
    }

    /**
     * Returns a value as a non-empty string, or fails.
     *
     * @param value - parsed value
     * @param where - location used in error messages
     */
    private static stringOf(value: unknown, where: string): string {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`${where} must be a non-empty string`);
        }
        return value;
    }

    /**
     * Returns a value as an integer of at least 1, or fails.
     *
     * @param value - parsed value
     * @param where - location used in error messages
     */
    private static positiveInteger(value: unknown, where: string): number {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
            throw new Error(`${where} must be an integer of at least 1`);
        }
        return value;
    }

    /**
     * Returns a value as a finite number above zero, or fails.
     *
     * @param value - parsed value
     * @param where - location used in error messages
     */
    private static positiveNumber(value: unknown, where: string): number {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            throw new Error(`${where} must be a positive number`);
        }
        return value;
    }

    /**
     * Returns a whole number, or a string holding a placeholder that is resolved at run time.
     *
     * @param value - parsed value
     * @param where - location used in error messages
     */
    private static countOrPlaceholder(value: unknown, where: string): number | string {
        if (Number.isInteger(value)) {
            return value as number;
        }
        if (typeof value === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)) {
            return value;
        }
        throw new Error(`${where} must be an integer or a placeholder such as "\${count}"`);
    }
}
