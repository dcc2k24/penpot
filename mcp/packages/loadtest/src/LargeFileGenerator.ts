import type { ToolCallOutcome } from "./McpLoadClient.js";

/** Version of the generation plan. Bump it when the shapes, their names or their order change. */
export const GENERATOR_VERSION = 1;

/** Values that the command line uses when an option is not given. */
export const LARGE_FILE_DEFAULTS = {
    shapes: 100_000,
    pages: 40,
    batch: 300,
    components: 50,
    instancesPerPage: 20,
    seed: 1,
} as const;

/** Calls that the generator makes. {@link McpLoadClient} satisfies it. */
export interface ToolCaller {
    /**
     * Calls one tool.
     *
     * @param name - tool name, for example apply_operations
     * @param args - tool arguments
     */
    callTool(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

/** Settings of one generation run. */
export interface GeneratorOptions {
    /** Project that receives the new file. */
    projectId: string;
    /** Target shape count over the whole file, library page included. The command line default is 100000. */
    shapes: number;
    /** Content pages, not counting the library page. The command line default is 40. */
    pages: number;
    /** Most nodes in one batch_create_shapes call. The command line default is 300. */
    batch: number;
    /** Library components. The command line default is 50. */
    components: number;
    /** Component copies on each content page. The command line default is 20. */
    instancesPerPage: number;
    /** Seed of every random choice in the file. The command line default is 1. */
    seed: number;
    /** File name. Defaults to `mcp-perf-large-<shapes>-s<seed>`. */
    name?: string;
    /** Receives one progress line per content page. Defaults to console.log. */
    log?: (line: string) => void;
    /** Clock in milliseconds, for tests. Defaults to performance.now. */
    now?: () => number;
}

/** What a generation run built, or how far it got before a call failed. */
export interface GeneratorResult {
    /** Id of the new file, or an empty string when it was not created. */
    fileId: string;
    /** Project of the new file. */
    projectId: string;
    /** First content page. Empty when the run stopped before the file had pages. */
    pageId: string;
    /** Content page ids. In outline order when the run completed, else in creation order. */
    pageIds: string[];
    /** Id of the library page. Empty when it was not created. */
    libraryPageId: string;
    /** Component ids in index order. */
    componentIds: string[];
    /** Shape count from the final outline, library page included. Zero when the run stopped before the outline. */
    shapeCount: number;
    /** Shape count per content page, in the same order as pageIds. Empty when the run stopped before the outline. */
    pageShapeCounts: number[];
    /** Pointer map flag from the final outline, or undefined when the outline does not report it. */
    pointerMap: boolean | undefined;
    /** Tool calls made, failed calls included. */
    calls: number;
    /** Wall-clock time of the run in milliseconds. */
    durationMs: number;
    /** Seed used. */
    seed: number;
    /** Version of the generation plan. */
    generatorVersion: number;
    /** True when every step ran and the outline was read. */
    complete: boolean;
    /** Why the run stopped, in the form `<tool> failed: <message>`. Absent when the run completed. */
    error?: string;
}

/** A node of a batch_create_shapes tree, as the generator writes it. */
interface BatchNode {
    /** Shape type: board, rect, ellipse or text. */
    type: "board" | "rect" | "ellipse" | "text";
    /** Layer name. */
    name: string;
    /** Absolute x of the top-left corner. */
    x: number;
    /** Absolute y of the top-left corner. */
    y: number;
    /** Width in pixels. */
    width: number;
    /** Height in pixels. */
    height: number;
    /** Other attributes, such as fills or fontSize. */
    props?: Record<string, unknown>;
    /** Text content of a text node. */
    characters?: string;
    /** Child nodes, created inside this shape. */
    children?: BatchNode[];
}

/** One node of a batch_create_shapes result. */
interface CreatedNode {
    /** Handle of the node in the call, such as $tmp:n0. */
    handle: string;
    /** Shape type as the call named it. */
    type: string;
    /** Layer name. */
    name?: string;
}

/** Result of one batch_create_shapes call, read into what the generator needs. */
interface CreatedTree {
    /** Every node of the tree, in document order. */
    nodes: CreatedNode[];
    /** Real id of each handle. */
    createdIds: Record<string, string>;
}

/** The layout of one section tree and the names that its layout ops need. */
interface SectionPlan {
    /** Root board of the section, with its title and rows. */
    root: BatchNode;
    /** Names of the row boards, in order. */
    rowNames: string[];
    /** Direct children of the root board: the title, when present, and the rows. */
    childCount: number;
}

/** Ids that the run has learned so far. */
interface RunState {
    /** First content page of the new file, renamed Content 1. */
    firstPageId: string;
    /** Library page. */
    libraryPageId: string;
    /** Component ids in index order. */
    componentIds: string[];
    /** Content page ids in creation order. */
    contentPageIds: string[];
}

/** The part of the final outline that the result needs. */
interface OutlineSummary {
    /** Sum of the shape counts of every page. */
    shapeCount: number;
    /** Shape count per content page, in outline order. */
    pageShapeCounts: number[];
    /** Content page ids, in outline order. */
    pageIds: string[];
    /** Pointer map flag, or undefined when the outline does not report it. */
    pointerMap: boolean | undefined;
}

/** Raised inside a run when a tool call fails or answers with an unexpected shape. */
class GenerationError extends Error {}

/** Handle of the library page in the create_page op. */
const LIBRARY_HANDLE = "$tmp:library";

/** Shapes in one component and in one copy of it: the board and its two children. */
const SHAPES_PER_COMPONENT = 3;

/** Most operations in one apply_operations call. */
const MAX_OPERATIONS = 2000;

/** Largest batch the generator asks for, the MCP server cap per tree. */
const MAX_BATCH = 2000;

/** Horizontal distance between two sections on a page. */
const SECTION_PITCH = 2000;

/** Cards in one line of a row. */
const CARDS_PER_LINE = 8;

/** Left edge of the copies of library components on a content page. */
const INSTANCE_X = 20_000;

/** Short everyday words for the titles and card texts. */
const WORDS = [
    "time",
    "people",
    "year",
    "way",
    "day",
    "man",
    "thing",
    "woman",
    "life",
    "child",
    "world",
    "school",
    "state",
    "family",
    "group",
    "country",
    "problem",
    "hand",
    "part",
    "place",
    "case",
    "week",
    "company",
    "system",
    "program",
    "question",
    "work",
    "government",
    "number",
    "night",
    "point",
    "home",
    "water",
    "room",
    "mother",
    "area",
    "money",
    "story",
    "fact",
    "month",
    "lot",
    "right",
    "study",
    "book",
    "eye",
    "job",
    "word",
    "issue",
    "side",
    "kind",
    "head",
    "house",
    "service",
    "friend",
    "father",
    "power",
    "hour",
    "game",
    "line",
    "end",
    "member",
    "law",
    "city",
    "team",
    "idea",
    "body",
    "back",
    "face",
    "level",
    "office",
    "door",
    "health",
    "art",
    "history",
    "party",
    "result",
    "change",
    "morning",
    "reason",
    "garden",
    "river",
    "bridge",
    "window",
    "market",
    "light",
    "stone",
    "paper",
    "color",
    "music",
    "field",
    "forest",
    "ocean",
    "road",
    "bread",
    "apple",
    "lamp",
    "chair",
    "table",
];

/**
 * Builds a large reference file through an MCP session, in a fixed order that depends only on the seed.
 *
 * The file has one library page with components, and content pages with component copies and sections of cards.
 * Every write sends `snapshot: false`. A failed call ends the run and the result reports it; the run does not throw.
 */
export class LargeFileGenerator {
    /** Session that receives the tool calls. */
    private readonly client: ToolCaller;

    /** Settings of the run. */
    private readonly options: GeneratorOptions;

    /** File name, resolved from the options. */
    private readonly name: string;

    /** Receives the progress lines. */
    private readonly log: (line: string) => void;

    /** Clock in milliseconds. */
    private readonly now: () => number;

    /** Random source of the current run, reset at the start of each run. */
    private random: () => number = mulberry32(1);

    /** Clock reading at the start of the current run. */
    private startedAt = 0;

    /** Tool calls made in the current run. */
    private calls = 0;

    /** Shapes created in the current run, library page included. */
    private created = 0;

    /** Id of the new file. Empty until the file exists. */
    private fileId = "";

    /**
     * Checks the settings and prepares the run. No call is made here.
     *
     * @param client - session that receives the tool calls
     * @param options - settings of the run
     * @throws Error when a setting is out of range or the library would fill the file
     */
    constructor(client: ToolCaller, options: GeneratorOptions) {
        LargeFileGenerator.validate(options);
        this.client = client;
        this.options = options;
        this.name = options.name ?? `mcp-perf-large-${options.shapes}-s${options.seed}`;
        this.log = options.log ?? ((line: string) => console.log(line));
        this.now = options.now ?? (() => performance.now());
    }

    /**
     * Builds the file. A failed call stops the run and is reported in the result.
     *
     * @returns what was built; `complete` is false when a call failed
     */
    async run(): Promise<GeneratorResult> {
        this.random = mulberry32(this.options.seed);
        this.startedAt = this.now();
        this.calls = 0;
        this.created = 0;
        this.fileId = "";
        const state: RunState = { firstPageId: "", libraryPageId: "", componentIds: [], contentPageIds: [] };
        try {
            const outline = await this.generate(state);
            return this.resultOf(state, outline, undefined);
        } catch (failure) {
            const message = failure instanceof Error ? failure.message : String(failure);
            return this.resultOf(state, undefined, message);
        }
    }

    /**
     * Checks the settings before any call.
     *
     * @param options - settings to check
     * @throws Error naming the first setting that is out of range
     */
    private static validate(options: GeneratorOptions): void {
        if (options.projectId === "") {
            throw new Error("projectId must not be empty");
        }
        requireWholeNumber(options.shapes, "shapes", 1);
        requireWholeNumber(options.pages, "pages", 1);
        requireWholeNumber(options.batch, "batch", 2, MAX_BATCH);
        requireWholeNumber(options.components, "components", 0);
        requireWholeNumber(options.instancesPerPage, "instancesPerPage", 0);
        requireWholeNumber(options.seed, "seed", 0);
        if (options.components * SHAPES_PER_COMPONENT >= options.shapes) {
            throw new Error("shapes must be more than the 3 shapes of each library component");
        }
    }

    /**
     * Makes the calls in order: the file, the library, the content pages, then the final move and outline.
     *
     * @param state - receives the ids as they become known
     * @returns the summary of the final outline
     */
    private async generate(state: RunState): Promise<OutlineSummary> {
        const { projectId, pages } = this.options;
        const fileInfo = await this.callObject("manage_files", { action: "create_file", projectId, name: this.name });
        this.fileId = stringOf(fileInfo.id, "manage_files", "file id");

        const outline = await this.callObject("get_file_outline", { fileId: this.fileId });
        const firstPages = arrayOf(outline.pages, "get_file_outline", "pages");
        if (firstPages.length === 0) {
            throw new GenerationError("get_file_outline returned no pages");
        }
        state.firstPageId = stringOf(objectOf(firstPages[0], "get_file_outline").id, "get_file_outline", "page id");
        state.contentPageIds.push(state.firstPageId);
        await this.applyOperations([{ op: "update_page", id: state.firstPageId, name: "Content 1" }]);

        const libraryIds = await this.applyOperations([{ op: "create_page", id: LIBRARY_HANDLE, name: "Library" }]);
        state.libraryPageId = requireId(libraryIds, LIBRARY_HANDLE, "apply_operations");

        await this.buildLibrary(state);
        await this.createContentPages(state);

        const libraryShapes = this.options.components * SHAPES_PER_COMPONENT;
        const contentBudget = this.options.shapes - libraryShapes;
        const perPage = Math.ceil(contentBudget / pages);
        let left = contentBudget;
        for (let page = 1; page <= pages; page++) {
            const budget = page < pages ? Math.min(perPage, left) : left;
            left -= budget;
            await this.buildPage(state, page, budget);
        }

        await this.applyOperations([{ op: "move_page", id: state.libraryPageId, index: pages }]);
        return this.readOutline(state);
    }

    /**
     * Creates the library page's components: root boards with a rect and a label, then one create_component per root.
     *
     * @param state - receives the component ids
     */
    private async buildLibrary(state: RunState): Promise<void> {
        const { components, batch } = this.options;
        const rootIds: string[] = [];
        const perCall = Math.max(1, Math.floor(batch / SHAPES_PER_COMPONENT));
        for (let first = 0; first < components; first += perCall) {
            const last = Math.min(components, first + perCall);
            const roots: BatchNode[] = [];
            for (let k = first; k < last; k++) {
                roots.push(this.libraryRoot(k));
            }
            const tree = await this.createTree(state.libraryPageId, roots);
            this.created += roots.length * SHAPES_PER_COMPONENT;
            let found = 0;
            for (const node of tree.nodes) {
                const match = /^Component (\d+)$/.exec(node.name ?? "");
                if (node.type === "board" && match !== null) {
                    rootIds[Number(match[1])] = requireId(tree.createdIds, node.handle, "batch_create_shapes");
                    found += 1;
                }
            }
            if (found !== roots.length) {
                throw new GenerationError(
                    `batch_create_shapes returned ${found} component roots, expected ${roots.length}`
                );
            }
        }

        const operations: Record<string, unknown>[] = [];
        for (let k = 0; k < components; k++) {
            operations.push({
                op: "create_component",
                pageId: state.libraryPageId,
                shapeIds: [requireElement(rootIds, k, "component root")],
                name: `Component ${k}`,
                path: `Perf/Group ${k % 5}`,
                id: componentHandle(k),
            });
        }
        if (operations.length > 0) {
            const ids = await this.applyOperations(operations);
            for (let k = 0; k < components; k++) {
                state.componentIds.push(requireId(ids, componentHandle(k), "apply_operations"));
            }
        }
    }

    /**
     * Builds one library root: a board with a seeded fill, a rect and a label.
     *
     * @param k - component index
     */
    private libraryRoot(k: number): BatchNode {
        const x = (k % 10) * 220;
        const y = Math.floor(k / 10) * 220;
        return {
            type: "board",
            name: `Component ${k}`,
            x,
            y,
            width: 200,
            height: 200,
            props: this.fill(),
            children: [
                { type: "rect", name: `Component ${k} bg`, x, y, width: 200, height: 120, props: this.fill() },
                {
                    type: "text",
                    name: `Component ${k} label`,
                    x: x + 10,
                    y: y + 140,
                    width: 180,
                    height: 40,
                    characters: `Button ${k}`,
                    props: { fontSize: 14 },
                },
            ],
        };
    }

    /**
     * Creates the content pages 2 to pages. Page 1 is the renamed first page.
     *
     * @param state - receives the page ids
     */
    private async createContentPages(state: RunState): Promise<void> {
        const { pages } = this.options;
        if (pages < 2) {
            return;
        }
        const operations: Record<string, unknown>[] = [];
        for (let page = 2; page <= pages; page++) {
            operations.push({ op: "create_page", id: contentHandle(page), name: `Content ${page}` });
        }
        const ids = await this.applyOperations(operations);
        for (let page = 2; page <= pages; page++) {
            state.contentPageIds.push(requireId(ids, contentHandle(page), "apply_operations"));
        }
    }

    /**
     * Fills one content page: component copies first, then sections until the page budget is used, then layouts.
     *
     * @param state - ids of the run
     * @param page - content page number, from 1
     * @param budget - shapes this page creates
     */
    private async buildPage(state: RunState, page: number, budget: number): Promise<void> {
        const { pages, batch, components, instancesPerPage } = this.options;
        const pageId = state.contentPageIds[page - 1];
        const pageStarted = this.now();
        const callsBefore = this.calls;
        const createdBefore = this.created;
        let left = budget;

        const instances = components > 0 ? Math.min(instancesPerPage, Math.floor(left / SHAPES_PER_COMPONENT)) : 0;
        if (instances > 0) {
            const operations: Record<string, unknown>[] = [];
            for (let i = 0; i < instances; i++) {
                const componentId = state.componentIds[Math.floor(this.random() * components)];
                operations.push({
                    op: "instantiate_component",
                    pageId,
                    componentId,
                    x: INSTANCE_X + (i % 10) * 220,
                    y: Math.floor(i / 10) * 220,
                });
            }
            await this.applyOperations(operations);
            left -= instances * SHAPES_PER_COMPONENT;
            this.created += instances * SHAPES_PER_COMPONENT;
        }

        const layouts: Record<string, unknown>[] = [];
        for (let index = 0; left > 0; index++) {
            const capacity = Math.min(batch, left);
            const plan = this.planSection(page, index, capacity);
            const tree = await this.createTree(pageId, [plan.root]);
            if (tree.nodes.length !== capacity) {
                throw new GenerationError(
                    `batch_create_shapes returned ${tree.nodes.length} nodes, expected ${capacity}`
                );
            }
            left -= capacity;
            this.created += capacity;
            layouts.push(...this.sectionLayouts(pageId, index, plan, tree));
        }
        if (layouts.length > 0) {
            await this.applyOperations(layouts);
        }

        const seconds = ((this.now() - pageStarted) / 1000).toFixed(1);
        const placed = this.created - createdBefore;
        this.log(
            `page ${page}/${pages}: ${placed} shapes in ${this.calls - callsBefore} calls, ${seconds} s ` +
                `(file total ${this.created} shapes, elapsed ${formatElapsed(this.now() - this.startedAt)})`
        );
    }

    /**
     * Plans one section tree that holds exactly `capacity` nodes.
     *
     * The tree is a root board, an optional title, and rows of cards. A card is a board with a rect, an ellipse
     * and a text, so it holds four nodes. The row count is the remainder of the nodes after the root and the title,
     * taken modulo four, which keeps the count exact.
     *
     * @param page - content page number
     * @param index - section index on the page
     * @param capacity - nodes in the tree, at least 1
     */
    private planSection(page: number, index: number, capacity: number): SectionPlan {
        const label = `${page}-${index}`;
        const left = index * SECTION_PITCH;
        const hasTitle = capacity === 2 || (capacity >= 3 && (capacity - 2) % 4 !== 0);
        const below = capacity - 1 - (hasTitle ? 1 : 0);
        const rowCount = below % 4;
        const cardTotal = (below - rowCount) / 4;

        const children: BatchNode[] = [];
        if (hasTitle) {
            children.push({
                type: "text",
                name: `Title ${label}`,
                x: left + 20,
                y: 20,
                width: 1860,
                height: 40,
                characters: this.phrase(3, 8),
                props: { fontSize: 24 },
            });
        }

        const rowNames: string[] = [];
        let rowY = 80;
        for (let row = 0; row < rowCount; row++) {
            const cardsInRow = Math.floor(cardTotal / rowCount) + (row < cardTotal % rowCount ? 1 : 0);
            const lines = Math.max(1, Math.ceil(cardsInRow / CARDS_PER_LINE));
            const rowHeight = 20 + lines * 220;
            const rowName = `Row ${label}-${row}`;
            rowNames.push(rowName);
            const cards: BatchNode[] = [];
            for (let column = 0; column < cardsInRow; column++) {
                const x = left + 30 + (column % CARDS_PER_LINE) * 210;
                const y = rowY + 10 + Math.floor(column / CARDS_PER_LINE) * 220;
                cards.push(this.cardNode(`${label}-${row}-${column}`, x, y));
            }
            children.push({
                type: "board",
                name: rowName,
                x: left + 20,
                y: rowY,
                width: 1860,
                height: rowHeight,
                children: cards,
            });
            rowY += rowHeight + 20;
        }

        return {
            root: { type: "board", name: `Section ${label}`, x: left, y: 0, width: 1900, height: rowY, children },
            rowNames,
            childCount: children.length,
        };
    }

    /**
     * Builds one card: a board with a rect, an ellipse and a text. Four nodes in all.
     *
     * @param label - card label, such as 1-0-2-3
     * @param x - left edge of the card
     * @param y - top edge of the card
     * @returns the card node
     */
    private cardNode(label: string, x: number, y: number): BatchNode {
        return {
            type: "board",
            name: `Board card ${label}`,
            x,
            y,
            width: 200,
            height: 200,
            children: [
                {
                    type: "rect",
                    name: `Rect ${label}`,
                    x: x + 10,
                    y: y + 10,
                    width: 180,
                    height: 100,
                    props: this.fill(),
                },
                {
                    type: "ellipse",
                    name: `Ellipse ${label}`,
                    x: x + 10,
                    y: y + 120,
                    width: 60,
                    height: 60,
                    props: this.fill(),
                },
                {
                    type: "text",
                    name: `Text ${label}`,
                    x: x + 80,
                    y: y + 130,
                    width: 110,
                    height: 40,
                    characters: this.phrase(2, 5),
                    props: { fontSize: 14 },
                },
            ],
        };
    }

    /**
     * Builds the layout ops of one section: flex on the rows every third section, grid on the root every fifth.
     *
     * @param pageId - page of the section
     * @param index - section index on the page
     * @param plan - the section plan
     * @param tree - the created nodes of the section
     * @returns the layout operations of the section, possibly none
     */
    private sectionLayouts(
        pageId: string,
        index: number,
        plan: SectionPlan,
        tree: CreatedTree
    ): Record<string, unknown>[] {
        const operations: Record<string, unknown>[] = [];
        const idOf = (name: string): string => {
            const node = tree.nodes.find((candidate) => candidate.name === name);
            if (node === undefined) {
                throw new GenerationError(`batch_create_shapes returned no node named ${name}`);
            }
            return requireId(tree.createdIds, node.handle, "batch_create_shapes");
        };
        if (index % 3 === 0) {
            for (const rowName of plan.rowNames) {
                operations.push({
                    op: "set_flex_layout",
                    pageId,
                    id: idOf(rowName),
                    layoutFlexDir: "row",
                    layoutWrapType: "wrap",
                    layoutGap: { rowGap: 8, columnGap: 8 },
                    layoutPadding: { p1: 8, p2: 8, p3: 8, p4: 8 },
                });
            }
        }
        if (index % 5 === 1 && plan.childCount > 0) {
            const rows = Math.ceil(plan.childCount / 2);
            operations.push({
                op: "set_grid_layout",
                pageId,
                id: requireId(tree.createdIds, tree.nodes[0].handle, "batch_create_shapes"),
                layoutGridRows: flexTracks(rows),
                layoutGridColumns: flexTracks(2),
                layoutGap: { rowGap: 8, columnGap: 8 },
            });
        }
        return operations;
    }

    /**
     * Reads the final outline and sums the shape counts.
     *
     * @param state - ids of the run, used to find the library page
     * @returns the sums and the page ids of the final outline
     */
    private async readOutline(state: RunState): Promise<OutlineSummary> {
        const outline = await this.callObject("get_file_outline", { fileId: this.fileId });
        const pages = arrayOf(outline.pages, "get_file_outline", "pages").map((entry) => {
            const page = objectOf(entry, "get_file_outline");
            return {
                id: stringOf(page.id, "get_file_outline", "page id"),
                shapeCount: numberOf(page.shapeCount, "get_file_outline", "shapeCount"),
            };
        });
        if (!pages.some((page) => page.id === state.libraryPageId)) {
            throw new GenerationError("get_file_outline does not list the library page");
        }
        const shapeCount = pages.reduce((sum, page) => sum + page.shapeCount, 0);
        if (shapeCount !== this.options.shapes) {
            this.log(`warning: the outline counts ${shapeCount} shapes, the target was ${this.options.shapes}`);
        }
        const contentPages = pages.filter((page) => page.id !== state.libraryPageId);
        return {
            shapeCount,
            pageShapeCounts: contentPages.map((page) => page.shapeCount),
            pageIds: contentPages.map((page) => page.id),
            pointerMap: typeof outline.pointerMap === "boolean" ? outline.pointerMap : undefined,
        };
    }

    /**
     * Turns the state of a run into the result. The outline fills the counts when it was read.
     *
     * @param state - ids learned so far
     * @param outline - the final outline, or undefined when the run stopped before it
     * @param error - why the run stopped, or undefined when it completed
     * @returns the result document
     */
    private resultOf(state: RunState, outline: OutlineSummary | undefined, error: string | undefined): GeneratorResult {
        const result: GeneratorResult = {
            fileId: this.fileId,
            projectId: this.options.projectId,
            pageId: outline?.pageIds[0] ?? state.firstPageId,
            pageIds: outline?.pageIds ?? state.contentPageIds,
            libraryPageId: state.libraryPageId,
            componentIds: state.componentIds,
            shapeCount: outline?.shapeCount ?? 0,
            pageShapeCounts: outline?.pageShapeCounts ?? [],
            pointerMap: outline?.pointerMap,
            calls: this.calls,
            durationMs: this.now() - this.startedAt,
            seed: this.options.seed,
            generatorVersion: GENERATOR_VERSION,
            complete: error === undefined,
        };
        if (error !== undefined) {
            result.error = error;
        }
        return result;
    }

    /**
     * Sends apply_operations calls of at most 2000 operations each, with snapshots off.
     *
     * @param operations - operations to apply, in order
     * @returns the real id of every handle that the calls created
     */
    private async applyOperations(operations: Record<string, unknown>[]): Promise<Record<string, string>> {
        const ids: Record<string, string> = {};
        for (let first = 0; first < operations.length; first += MAX_OPERATIONS) {
            const chunk = operations.slice(first, first + MAX_OPERATIONS);
            const json = await this.callObject("apply_operations", {
                fileId: this.fileId,
                operations: chunk,
                allowSplit: true,
                snapshot: false,
            });
            const created = json.createdIds ?? {};
            for (const [handle, id] of Object.entries(objectOf(created, "apply_operations"))) {
                ids[handle] = stringOf(id, "apply_operations", `id for ${handle}`);
            }
        }
        return ids;
    }

    /**
     * Sends one batch_create_shapes call with snapshots off.
     *
     * @param pageId - page that receives the tree
     * @param roots - root nodes of the tree
     * @returns the created nodes and their ids
     */
    private async createTree(pageId: string, roots: BatchNode[]): Promise<CreatedTree> {
        const json = await this.callObject("batch_create_shapes", {
            fileId: this.fileId,
            pageId,
            tree: roots,
            snapshot: false,
        });
        const nodes = arrayOf(json.nodes, "batch_create_shapes", "nodes").map((entry) => {
            const node = objectOf(entry, "batch_create_shapes");
            const created: CreatedNode = {
                handle: stringOf(node.handle, "batch_create_shapes", "handle"),
                type: stringOf(node.type, "batch_create_shapes", "node type"),
            };
            if (typeof node.name === "string") {
                created.name = node.name;
            }
            return created;
        });
        const result = objectOf(json.result, "batch_create_shapes");
        const createdIds: Record<string, string> = {};
        for (const [handle, id] of Object.entries(objectOf(result.createdIds, "batch_create_shapes"))) {
            createdIds[handle] = stringOf(id, "batch_create_shapes", `id for ${handle}`);
        }
        return { nodes, createdIds };
    }

    /**
     * Calls one tool and returns its JSON object.
     *
     * @param tool - tool name
     * @param args - tool arguments
     * @returns the JSON object of the answer
     * @throws GenerationError when the call fails or the answer is not a JSON object
     */
    private async callObject(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.calls += 1;
        const outcome = await this.client.callTool(tool, args);
        if (!outcome.ok) {
            throw new GenerationError(`${tool} failed: ${outcome.error ?? (outcome.text || "no message")}`);
        }
        return objectOf(outcome.json, tool);
    }

    /**
     * Draws a seeded fill for a shape props object.
     *
     * @returns the props with one solid fill
     */
    private fill(): Record<string, unknown> {
        const color = Math.floor(this.random() * 0x1000000)
            .toString(16)
            .padStart(6, "0");
        return { fills: [{ fillColor: `#${color}`, fillOpacity: 1 }] };
    }

    /**
     * Draws a seeded phrase of everyday words, with a capital at the start.
     *
     * @param min - fewest words
     * @param max - most words
     * @returns the phrase
     */
    private phrase(min: number, max: number): string {
        const count = min + Math.floor(this.random() * (max - min + 1));
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
            words.push(WORDS[Math.floor(this.random() * WORDS.length)]);
        }
        const text = words.join(" ");
        return text.charAt(0).toUpperCase() + text.slice(1);
    }
}

/**
 * Formats a duration as minutes and seconds, such as 2m05s.
 *
 * @param milliseconds - duration to format
 */
export function formatElapsed(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Makes a seeded pseudo-random source with values from 0 up to 1, not including 1.
 *
 * @param seed - any integer
 */
function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Handle of the content page with the given number.
 *
 * @param page - content page number
 */
function contentHandle(page: number): string {
    return `$tmp:content${page}`;
}

/**
 * Handle of the component with the given index.
 *
 * @param k - component index
 */
function componentHandle(k: number): string {
    return `$tmp:c${k}`;
}

/**
 * Row tracks of flex size, one per row or column.
 *
 * @param count - number of tracks
 */
function flexTracks(count: number): Array<{ type: string; value: number }> {
    return Array.from({ length: count }, () => ({ type: "flex", value: 1 }));
}

/**
 * Checks that a setting is a whole number inside a range.
 *
 * @param value - value to check
 * @param name - setting name for the message
 * @param minimum - smallest allowed value
 * @param maximum - largest allowed value
 * @throws Error when the value is out of range
 */
function requireWholeNumber(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
    }
}

/**
 * Reads a value that must be a JSON object.
 *
 * @param value - value to check
 * @param tool - tool name for the message
 * @throws GenerationError when the value is not an object
 */
function objectOf(value: unknown, tool: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new GenerationError(`${tool} returned no JSON object`);
    }
    return value as Record<string, unknown>;
}

/**
 * Reads a value that must be a JSON array.
 *
 * @param value - value to check
 * @param tool - tool name for the message
 * @param what - name of the field for the message
 * @throws GenerationError when the value is not an array
 */
function arrayOf(value: unknown, tool: string, what: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new GenerationError(`${tool} returned no ${what} list`);
    }
    return value;
}

/**
 * Reads a value that must be a non-empty string.
 *
 * @param value - value to check
 * @param tool - tool name for the message
 * @param what - name of the field for the message
 * @throws GenerationError when the value is not a non-empty string
 */
function stringOf(value: unknown, tool: string, what: string): string {
    if (typeof value !== "string" || value === "") {
        throw new GenerationError(`${tool} returned no ${what}`);
    }
    return value;
}

/**
 * Reads a value that must be a number.
 *
 * @param value - value to check
 * @param tool - tool name for the message
 * @param what - name of the field for the message
 * @throws GenerationError when the value is not a number
 */
function numberOf(value: unknown, tool: string, what: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new GenerationError(`${tool} returned no ${what}`);
    }
    return value;
}

/**
 * Looks up the real id of a handle.
 *
 * @param ids - handle to id map
 * @param handle - handle to look up
 * @param tool - tool name for the message
 * @throws GenerationError when the handle has no id
 */
function requireId(ids: Record<string, string>, handle: string, tool: string): string {
    const id: string | undefined = ids[handle];
    if (id === undefined) {
        throw new GenerationError(`${tool} returned no id for ${handle}`);
    }
    return id;
}

/**
 * Reads an element of a list that the generator filled, failing when it is missing.
 *
 * @param list - the list
 * @param index - element to read
 * @param what - name of the element for the message
 * @throws GenerationError when the element is missing
 */
function requireElement<T>(list: T[], index: number, what: string): T {
    const element: T | undefined = list[index];
    if (element === undefined) {
        throw new GenerationError(`no ${what} ${index} was created`);
    }
    return element;
}
