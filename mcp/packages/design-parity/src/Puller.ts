import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesignModel } from "./DesignModel.js";
import { expectArray, expectRecord, McpSession } from "./McpSession.js";
import { DesignNormaliser, type NormaliserInput } from "./Normaliser.js";
import { assertCovered, FieldCoverage, observeTree, SHAPE_FIELDS, TREE_FIELDS } from "./PullFields.js";
import { fetchShapeChunks } from "./ShapeChunks.js";
import { DESIGN_FILE, OUT_DIR } from "./Paths.js";

/** Id of the root of every page tree. The root is not a shape of the page. */
const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Depth of the page tree that get_page_tree returns. */
const TREE_DEPTH = 20;

/** Maximum number of nodes that get_page_tree returns in one response. */
const TREE_LIMIT = 5000;

/** Raw JSON object as the backend returns it. */
type RawRecord = Record<string, unknown>;

/** Id and name of one page of the outline. */
interface PageRef {
    /** Id of the page. */
    readonly id: string;
    /** Name of the page. */
    readonly name: string;
}

/**
 * Pulls the state of a file from the backend and writes it as a normalised model to design.json. The raw responses
 * go to the raw folder of the output, one file per response.
 */
export class DesignPuller {
    private readonly session: McpSession;
    private readonly fileId: string;
    private readonly log: (line: string) => void;
    private readonly rawDir: string;

    /**
     * Creates a puller for one file. The session must be connected.
     *
     * @param session - connected MCP session
     * @param fileId - id of the file to pull
     * @param log - receives one line per step, defaults to console.log
     */
    constructor(session: McpSession, fileId: string, log: (line: string) => void = (line) => console.log(line)) {
        this.session = session;
        this.fileId = fileId;
        this.log = log;
        this.rawDir = join(OUT_DIR, "raw");
    }

    /**
     * Pulls the file, writes design.json and returns the model.
     *
     * @throws Error when a backend call fails, a page tree or shape list is truncated, or the model cannot be built
     */
    async pull(): Promise<DesignModel> {
        const started = performance.now();
        this.resetRawDir();

        let step = performance.now();
        const outlineResult = await this.session.call("get_file_outline", { fileId: this.fileId });
        this.writeRaw("outline.json", outlineResult.json);
        const outline = expectRecord(outlineResult.json, "get_file_outline");
        const pages = this.outlinePages(outline);
        this.report("outline", step, `${pages.length} pages`);

        step = performance.now();
        const trees = new Map<string, RawRecord>();
        const pageRoots = new Map<string, RawRecord>();
        for (const page of pages) {
            const root = await this.fetchPageRoot(page);
            pageRoots.set(page.id, root);
            trees.set(page.id, { root });
        }
        const treeCoverage = new FieldCoverage(TREE_FIELDS);
        for (const root of pageRoots.values()) {
            observeTree(root, treeCoverage);
        }
        assertCovered("get_page_tree", treeCoverage);
        this.report("trees", step, `${pages.length} pages`);

        step = performance.now();
        const shapes = new Map<string, RawRecord>();
        for (const page of pages) {
            const root = pageRoots.get(page.id) ?? {};
            await this.fetchShapes(page, this.collectIds(root), shapes);
        }
        const shapeCoverage = new FieldCoverage(SHAPE_FIELDS);
        for (const shape of shapes.values()) {
            shapeCoverage.observe(shape);
        }
        assertCovered("get_shapes", shapeCoverage);
        this.report("shapes", step, `${shapes.size} shapes`);

        step = performance.now();
        const libraryResult = await this.session.call("get_library", { fileId: this.fileId });
        this.writeRaw("library.json", libraryResult.json);
        const library = expectRecord(libraryResult.json, "get_library");
        this.report("library", step);

        step = performance.now();
        const tokensResult = await this.session.call("get_tokens", { fileId: this.fileId });
        this.writeRaw("tokens.json", tokensResult.json);
        const tokens = expectRecord(tokensResult.json, "get_tokens");
        this.report("tokens", step);

        step = performance.now();
        const input: NormaliserInput = {
            outline,
            trees,
            shapes,
            library,
            tokens,
            pulledAt: new Date().toISOString(),
        };
        const model = new DesignNormaliser().normalise(input);
        this.writeModel(model);
        this.report("normalise", step);

        this.report("total", started);
        return model;
    }

    /**
     * Reads the id and name of every page of the outline, in outline order.
     *
     * @param outline - result of get_file_outline
     * @throws Error when the outline has no page list or a page lacks a string id or name
     */
    private outlinePages(outline: RawRecord): PageRef[] {
        return expectArray(outline.pages, "get_file_outline pages").map((entry, index) => {
            const page = expectRecord(entry, `outline page ${index}`);
            return {
                id: stringField(page, "id", `outline page ${index}`),
                name: stringField(page, "name", `outline page ${index}`),
            };
        });
    }

    /**
     * Fetches the whole tree of one page, following the cursor while the response is truncated. The responses are
     * merged into one page root.
     *
     * @param page - page to fetch
     * @throws Error when a response has no root object
     */
    private async fetchPageRoot(page: PageRef): Promise<RawRecord> {
        const slug = slugOf(page.name);
        const roots: RawRecord[] = [];
        let cursor: string | undefined = undefined;
        for (let call = 1; ; call++) {
            const args: Record<string, unknown> = {
                fileId: this.fileId,
                pageId: page.id,
                depth: TREE_DEPTH,
                limit: TREE_LIMIT,
                fields: [...TREE_FIELDS],
            };
            if (cursor !== undefined) {
                args.cursor = cursor;
            }
            const result = await this.session.call("get_page_tree", args);
            const response = expectRecord(result.json, `get_page_tree for page ${page.name}`);
            this.writeRaw(call === 1 ? `tree-${slug}.json` : `tree-${slug}-${call}.json`, response);
            roots.push(expectRecord(response.root, `get_page_tree root for page ${page.name}`));
            if (response.truncated !== true || typeof response.nextCursor !== "string") {
                break;
            }
            cursor = response.nextCursor;
        }
        return mergeRoots(roots, page.name);
    }

    /**
     * Fetches the shapes of one page. The ids go out in chunks, and a cut answer is asked again in halves, so the
     * shapes are read whatever the size limit is. The shapes go into the shared map in the order of the ids.
     *
     * @param page - page the ids belong to
     * @param ids - ids of the page tree, root excluded
     * @param shapes - shared map from id to raw shape, filled in place
     * @throws Error when a single shape is cut at the size limit, or a response is malformed
     */
    private async fetchShapes(page: PageRef, ids: string[], shapes: Map<string, RawRecord>): Promise<void> {
        const slug = slugOf(page.name);
        let requestNumber = 0;
        const result = await fetchShapeChunks(
            ids,
            async (chunk) => {
                requestNumber += 1;
                const answer = await this.session.call("get_shapes", {
                    fileId: this.fileId,
                    pageId: page.id,
                    ids: chunk,
                    fields: [...SHAPE_FIELDS],
                });
                const response = expectRecord(answer.json, `get_shapes for page ${page.name}`);
                this.writeRaw(`shapes-${slug}-${requestNumber}.json`, response);
                const entries = expectArray(response.shapes, `get_shapes shapes for page ${page.name}`);
                return {
                    shapes: entries.filter(isRecord),
                    missing: Array.isArray(response.missing)
                        ? response.missing.filter((id): id is string => typeof id === "string")
                        : [],
                    truncated: response.truncated === true,
                };
            },
            `page ${page.name}`
        );
        for (const id of ids) {
            const shape = result.shapes.get(id);
            if (shape !== undefined) {
                shapes.set(id, shape);
            }
        }
        if (result.missing.length > 0) {
            this.log(`[pull] shapes: ${result.missing.length} ids missing`);
        }
    }

    /**
     * Collects the id of every node below the page root, depth first. Each id is listed once.
     *
     * @param root - merged page root
     */
    private collectIds(root: RawRecord): string[] {
        const ids: string[] = [];
        const seen = new Set<string>();
        const visit = (node: RawRecord): void => {
            for (const child of childrenOf(node, "tree node")) {
                if (!isRecord(child)) {
                    continue;
                }
                if (typeof child.id === "string" && child.id !== ROOT_ID && !seen.has(child.id)) {
                    seen.add(child.id);
                    ids.push(child.id);
                }
                visit(child);
            }
        };
        visit(root);
        return ids;
    }

    /**
     * Deletes the raw folder of the previous pull and creates an empty one.
     */
    private resetRawDir(): void {
        rmSync(this.rawDir, { recursive: true, force: true });
        mkdirSync(this.rawDir, { recursive: true });
    }

    /**
     * Writes one raw response to the raw folder.
     *
     * @param name - file name inside the raw folder
     * @param value - parsed JSON value to write
     */
    private writeRaw(name: string, value: unknown): void {
        writeFileSync(join(this.rawDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }

    /**
     * Writes the model to design.json, creating the output folder when needed.
     *
     * @param model - normalised model
     */
    private writeModel(model: DesignModel): void {
        mkdirSync(dirname(DESIGN_FILE), { recursive: true });
        writeFileSync(DESIGN_FILE, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    }

    /**
     * Prints one timing line for a step.
     *
     * @param step - name of the step
     * @param started - start time from performance.now()
     * @param extra - optional text after the timing
     */
    private report(step: string, started: number, extra?: string): void {
        const ms = Math.round(performance.now() - started);
        this.log(`[pull] ${step} ${ms} ms${extra === undefined ? "" : ` ${extra}`}`);
    }
}

/**
 * Turns a page name into a file-name slug: lower case, runs of other characters replaced by one dash, and no dash at
 * either end.
 *
 * @param name - page name
 */
function slugOf(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Merges the roots of the responses of one page. The children of every later root are appended to the first root,
 * and a child whose id is already present is skipped.
 *
 * @param roots - roots of the responses, in response order
 * @param pageName - page name, used in errors
 * @throws Error when there is no root
 */
function mergeRoots(roots: RawRecord[], pageName: string): RawRecord {
    const [first, ...later] = roots;
    if (first === undefined) {
        throw new Error(`no page root for page ${pageName}`);
    }
    const children = [...childrenOf(first, pageName)];
    const seen = new Set<string>();
    for (const child of children) {
        if (isRecord(child) && typeof child.id === "string") {
            seen.add(child.id);
        }
    }
    for (const root of later) {
        for (const child of childrenOf(root, pageName)) {
            const id = isRecord(child) ? child.id : undefined;
            if (typeof id === "string") {
                if (seen.has(id)) {
                    continue;
                }
                seen.add(id);
            }
            children.push(child);
        }
    }
    first.children = children;
    return first;
}

/**
 * Reads the children list of a tree node. A node without a children key has no children.
 *
 * @param node - tree node or root
 * @param context - name of the node, used in errors
 * @throws Error when the children value is not an array
 */
function childrenOf(node: RawRecord, context: string): unknown[] {
    if (node.children === undefined) {
        return [];
    }
    return expectArray(node.children, `children of ${context}`);
}

/**
 * Reads a string field of a JSON object.
 *
 * @param record - JSON object
 * @param key - field name
 * @param context - name of the object, used in the error
 * @throws Error when the field is not a string
 */
function stringField(record: RawRecord, key: string, context: string): string {
    const value = record[key];
    if (typeof value !== "string") {
        throw new Error(`${context}: ${key} is not a string`);
    }
    return value;
}

/**
 * Checks that a value is a JSON object that is not an array.
 *
 * @param value - value to check
 */
function isRecord(value: unknown): value is RawRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
