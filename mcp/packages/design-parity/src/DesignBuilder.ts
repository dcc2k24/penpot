import { splitIntoBatches } from "./Batching.js";
import {
    DESIGN_SPEC,
    LAYOUT,
    TYPOGRAPHIES,
    fontVariantIdOf,
    instanceReferences,
    layoutComponentPage,
    normalizeName,
    screenFullName,
    type ComponentSpec,
    type TypographyName,
} from "./DesignSpec.js";
import { IdsStore, type BatchRecord } from "./IdsStore.js";
import { McpSession, McpToolError, RETRY_DELAYS_MS, delay, expectArray, expectRecord } from "./McpSession.js";
import {
    OperationPlanner,
    type Operation,
    type OverrideJob,
    type PathStep,
    type PlannedGroup,
} from "./OperationPlanner.js";
import { backendTokenType } from "./TokenTypes.js";

/** Largest number of operations in one apply_operations call. */
const MAX_OPS_PER_BATCH = 300;

/** Depth of the page tree read after each write. */
const TREE_DEPTH = 20;

/** Largest number of nodes in one page tree read. */
const TREE_LIMIT = 5000;

/**
 * Failure of the build itself, such as a missing name after a write or an invalid spec.
 */
export class BuildError extends Error {
    /**
     * Creates the error.
     *
     * @param message - what went wrong, with the backend text when there is one
     */
    constructor(message: string) {
        super(message);
        this.name = "BuildError";
    }
}

/**
 * Summary of a finished build.
 */
export interface BuildReport {
    readonly fileId: string;
    readonly pages: Readonly<Record<string, string>>;
    readonly nodeCounts: Readonly<Record<string, number>>;
    readonly batches: readonly BatchRecord[];
    readonly totalMs: number;
}

/**
 * One write of operations with the check that tells whether it was already applied.
 */
interface WriteBatch {
    readonly label: string;
    readonly pageId?: string;
    readonly ops: Operation[];
    readonly verify: () => Promise<boolean>;
}

/**
 * Node of a page tree as read back from the backend.
 */
interface TreeNode {
    readonly id: string;
    readonly name: string;
    readonly children: readonly TreeNode[];
}

/**
 * Page tree read with `get_page_tree`.
 */
interface PageTree {
    readonly root: TreeNode;
    readonly revn: number | undefined;
}

/**
 * Component as listed by `get_library`.
 */
interface LibraryComponent {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly mainInstanceId: string;
    readonly deleted: boolean;
}

/**
 * Library summary read with `get_library`.
 */
interface Library {
    readonly components: readonly LibraryComponent[];
    readonly typographies: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Named entries read with `get_tokens`.
 */
interface TokenIndex {
    readonly sets: readonly { readonly id: string; readonly name: string }[];
    readonly themes: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Builds the Design Lab file from the spec, through the backend MCP only. Every build starts from a new file.
 */
export class DesignBuilder {
    private readonly session: McpSession;
    private readonly ids: IdsStore;
    private readonly log: (line: string) => void;
    private readonly typographyIds = new Map<string, string>();
    private readonly componentIds = new Map<string, string>();
    private readonly planner: OperationPlanner;
    private fileId = "";
    private revn: number | undefined = undefined;

    /**
     * Creates a builder.
     *
     * @param session - connected MCP session
     * @param ids - store that records the build in `out/ids.json`
     * @param log - receives one progress line per step
     */
    constructor(session: McpSession, ids: IdsStore, log: (line: string) => void = (line) => console.log(line)) {
        this.session = session;
        this.ids = ids;
        this.log = log;
        this.planner = new OperationPlanner(this.typographyIds, this.componentIds);
    }

    /**
     * Builds the file: deletes the file recorded by an earlier build, creates a new file and fills it.
     *
     * @param projectId - project that receives the new file
     * @throws McpToolError or BuildError when a step fails
     */
    async build(projectId: string): Promise<BuildReport> {
        const started = performance.now();
        await this.deleteRecordedFile();
        this.fileId = await this.createFile(projectId);
        const pageIds = await this.createPages();
        await this.createTokens();
        await this.createTypographies();
        await this.createComponents(this.requirePage(pageIds, DESIGN_SPEC.componentPageName));
        await this.createJourneys(pageIds);
        const nodeCounts: Record<string, number> = {};
        for (const [pageName, pageId] of Object.entries(pageIds)) {
            const count = countNodes((await this.readPageTree(pageId)).root);
            nodeCounts[pageName] = count;
            this.ids.setNodeCount(pageName, count);
        }
        return {
            fileId: this.fileId,
            pages: pageIds,
            nodeCounts,
            batches: this.ids.snapshot().batches,
            totalMs: performance.now() - started,
        };
    }

    /**
     * Deletes the file recorded in `out/ids.json`, if there is one. A file that is already gone is not an error.
     */
    private async deleteRecordedFile(): Promise<void> {
        const previous = IdsStore.readRecordedFileId();
        if (previous === undefined) {
            return;
        }
        try {
            await this.session.call("manage_files", { action: "delete_file", fileId: previous });
            this.log(`[build] deleted the file recorded by the earlier build: ${previous}`);
        } catch (error) {
            if (error instanceof McpToolError && /not[ _-]?found/i.test(error.message)) {
                this.log("[build] the file recorded by the earlier build was already gone");
                return;
            }
            throw error;
        }
    }

    /**
     * Creates the new file in the project and records its id.
     *
     * @param projectId - project that receives the file
     */
    private async createFile(projectId: string): Promise<string> {
        const result = await this.session.call("manage_files", {
            action: "create_file",
            projectId,
            name: DESIGN_SPEC.fileName,
        });
        const json = expectRecord(result.json, "create_file");
        if (typeof json.id !== "string") {
            throw new BuildError("create_file returned no file id");
        }
        this.ids.reset(json.id, projectId);
        this.log(`[build] created file ${json.id}`);
        return json.id;
    }

    /**
     * Renames the default page to the Components page and creates one page per journey.
     *
     * @returns page id by page name
     */
    private async createPages(): Promise<Record<string, string>> {
        const outline = await this.readOutline();
        const first = outline.pages[0];
        if (first === undefined) {
            throw new BuildError("the new file has no default page");
        }
        const expected = [
            DESIGN_SPEC.componentPageName,
            ...DESIGN_SPEC.journeys.map((journey) => `${DESIGN_SPEC.journeyPagePrefix}${journey.name}`),
        ];
        const ops: Operation[] = [{ op: "update_page", id: first.id, name: DESIGN_SPEC.componentPageName }];
        DESIGN_SPEC.journeys.forEach((journey, index) => {
            ops.push({
                op: "create_page",
                id: `$tmp:journey${index}`,
                name: `${DESIGN_SPEC.journeyPagePrefix}${journey.name}`,
            });
        });
        await this.writeBatch({
            label: "pages",
            ops,
            verify: async () => {
                const current = await this.readOutline();
                return expected.every((name) => current.pages.some((page) => page.name === name));
            },
        });
        const after = await this.readOutline();
        const pageIds: Record<string, string> = {};
        for (const name of expected) {
            const page = after.pages.find((candidate) => candidate.name === name);
            if (page === undefined) {
                throw new BuildError(`page "${name}" was not created`);
            }
            pageIds[name] = page.id;
            this.ids.setPage(name, page.id);
        }
        return pageIds;
    }

    /**
     * Creates the `core` token set, its tokens and the `light` theme, and activates the theme.
     */
    private async createTokens(): Promise<void> {
        const ops: Operation[] = [{ op: "create_token_set", id: "$tmp:core", name: "core", active: true }];
        for (const token of DESIGN_SPEC.tokens) {
            ops.push({
                op: "create_token",
                setId: "$tmp:core",
                type: backendTokenType(token.type),
                name: token.name,
                value: token.value,
            });
        }
        ops.push({ op: "create_theme", id: "$tmp:light", group: "mode", name: "light", sets: ["core"] });
        ops.push({ op: "set_tokens_status", themeIds: ["$tmp:light"], setIds: ["$tmp:core"] });
        await this.writeBatch({
            label: "tokens",
            ops,
            verify: async () => {
                const index = await this.readTokens();
                return (
                    index.sets.some((set) => set.name === "core") &&
                    index.themes.some((theme) => theme.name === "light")
                );
            },
        });
        const index = await this.readTokens();
        const setId = index.sets.find((set) => set.name === "core")?.id;
        const themeId = index.themes.find((theme) => theme.name === "light")?.id;
        if (setId === undefined || themeId === undefined) {
            throw new BuildError("the token set or the theme was not found after the write");
        }
        this.ids.setTokens(setId, themeId);
    }

    /**
     * Creates the typographies and records their library ids.
     */
    private async createTypographies(): Promise<void> {
        const names = Object.keys(TYPOGRAPHIES) as TypographyName[];
        const font = DESIGN_SPEC.font;
        const ops: Operation[] = names.map((name) => {
            const style = TYPOGRAPHIES[name];
            return {
                op: "create_typography",
                typography: {
                    name,
                    fontId: font.fontId,
                    fontFamily: font.fontFamily,
                    fontVariantId: fontVariantIdOf(style.fontWeight),
                    fontSize: style.fontSize,
                    fontWeight: style.fontWeight,
                    lineHeight: style.lineHeight,
                    letterSpacing: "0",
                    textTransform: "none",
                    fontStyle: "normal",
                },
            };
        });
        await this.writeBatch({
            label: "typographies",
            ops,
            verify: async () => {
                const library = await this.readLibrary();
                return names.every((name) => library.typographies.some((typography) => typography.name === name));
            },
        });
        const library = await this.readLibrary();
        for (const name of names) {
            const typography = library.typographies.find((candidate) => candidate.name === name);
            if (typography === undefined) {
                throw new BuildError(`typography "${name}" was not found after the write`);
            }
            this.typographyIds.set(name, typography.id);
            this.ids.setTypography(name, typography.id);
        }
    }

    /**
     * Creates the main components in dependency waves. Each wave is written family by family, then its component ids
     * are read from the library, then its text overrides are applied.
     *
     * @param pageId - id of the Components page
     */
    private async createComponents(pageId: string): Promise<void> {
        const placed = layoutComponentPage(DESIGN_SPEC.families);
        const specs = placed.flatMap((family) => family.components.map((item) => item.spec));
        const waves = componentWaves(specs);
        for (const [waveIndex, wave] of waves.entries()) {
            const inWave = new Set(wave.map((spec) => normalizeName(spec.name)));
            const overrides: OverrideJob[] = [];
            for (const family of placed) {
                const groups: PlannedGroup[] = [];
                if (waveIndex === 0) {
                    groups.push(this.planner.planTitle(pageId, family.title, family.titleAt));
                }
                for (const item of family.components) {
                    if (inWave.has(normalizeName(item.spec.name))) {
                        groups.push(this.planner.planComponent(pageId, item.spec, item.at));
                    }
                }
                if (groups.length === 0) {
                    continue;
                }
                for (const batch of splitIntoBatches(
                    groups.map((group) => group.ops),
                    MAX_OPS_PER_BATCH
                )) {
                    const names = namesInBatch(groups, batch);
                    await this.writeBatch({
                        label: `components ${family.title} (wave ${waveIndex + 1})`,
                        pageId,
                        ops: batch,
                        verify: () => this.hasTopLevelNames(pageId, names),
                    });
                }
                for (const group of groups) {
                    overrides.push(...group.overrides);
                }
            }
            await this.recordComponents(wave);
            await this.applyOverrides(pageId, overrides);
        }
        const expected = [
            ...placed.map((family) => normalizeName(family.title)),
            ...specs.map((spec) => normalizeName(spec.name)),
        ];
        if (!(await this.hasTopLevelNames(pageId, expected))) {
            throw new BuildError("some components or section titles are missing from the Components page");
        }
    }

    /**
     * Reads the library and records the id of each component of one wave.
     *
     * @param wave - components built in this wave
     */
    private async recordComponents(wave: readonly ComponentSpec[]): Promise<void> {
        const library = await this.readLibrary();
        for (const spec of wave) {
            const fullName = normalizeName(spec.name);
            const found = library.components.find(
                (component) =>
                    !component.deleted && normalizeName(joinPath(component.path, component.name)) === fullName
            );
            if (found === undefined) {
                throw new BuildError(`component "${fullName}" is missing from the library`);
            }
            this.componentIds.set(fullName, found.id);
            this.ids.setComponent(fullName, { mainBoardId: found.mainInstanceId, componentId: found.id });
        }
    }

    /**
     * Creates one page per journey with its screens, then applies the screen text overrides.
     *
     * @param pageIds - page id by page name
     */
    private async createJourneys(pageIds: Record<string, string>): Promise<void> {
        for (const journey of DESIGN_SPEC.journeys) {
            const pageName = `${DESIGN_SPEC.journeyPagePrefix}${journey.name}`;
            const pageId = this.requirePage(pageIds, pageName);
            const groups = journey.screens.map((screen, index) =>
                this.planner.planScreen(pageId, screen, {
                    x: LAYOUT.originX + index * (LAYOUT.screenWidth + LAYOUT.screenColumnGap),
                    y: LAYOUT.originY,
                })
            );
            for (const batch of splitIntoBatches(
                groups.map((group) => group.ops),
                MAX_OPS_PER_BATCH
            )) {
                const names = namesInBatch(groups, batch);
                await this.writeBatch({
                    label: `journey ${journey.name}`,
                    pageId,
                    ops: batch,
                    verify: () => this.hasTopLevelNames(pageId, names),
                });
            }
            await this.applyOverrides(
                pageId,
                groups.flatMap((group) => group.overrides)
            );
            const tree = await this.readPageTree(pageId);
            for (const screen of journey.screens) {
                const fullName = screenFullName(screen);
                const board = tree.root.children.find((child) => normalizeName(child.name) === normalizeName(fullName));
                if (board === undefined) {
                    throw new BuildError(`screen "${fullName}" is missing from ${pageName}`);
                }
                this.ids.setScreen(fullName, board.id);
            }
        }
    }

    /**
     * Applies text overrides to instance children. The instances are found by walking the page tree, so their ids
     * never need to come from a write response.
     *
     * @param pageId - page that holds the instances
     * @param jobs - overrides to apply, in order
     */
    private async applyOverrides(pageId: string, jobs: readonly OverrideJob[]): Promise<void> {
        if (jobs.length === 0) {
            return;
        }
        const tree = await this.readPageTree(pageId);
        const groups: Operation[][] = jobs.map((job) => {
            const instance = resolvePath(tree.root, job.path);
            return Object.entries(job.overrides).map(([childName, characters]) => {
                const target = findDescendant(instance, childName);
                if (target === undefined) {
                    throw new BuildError(`text "${childName}" is missing in instance "${instance.name}"`);
                }
                return { op: "set_text", pageId, id: target.id, characters };
            });
        });
        for (const batch of splitIntoBatches(groups, MAX_OPS_PER_BATCH)) {
            await this.writeBatch({
                label: "text overrides",
                pageId,
                ops: batch,
                verify: async () => false,
            });
        }
    }

    /**
     * Sends one write, pinned to the last known revision. A transient failure is checked before any retry, because the
     * write may already have been applied. `verify` returns true when it was.
     *
     * @param batch - the operations and their check
     * @throws McpToolError on a rejected write or after the last retry, BuildError when validation fails
     */
    private async writeBatch(batch: WriteBatch): Promise<void> {
        const started = performance.now();
        for (let attempt = 0; ; attempt++) {
            try {
                const args: Record<string, unknown> = { fileId: this.fileId, operations: batch.ops };
                if (this.revn !== undefined) {
                    args.baseRevn = this.revn;
                }
                const result = await this.session.call("apply_operations", args, { retryTransient: false });
                const json = expectRecord(result.json, `apply_operations (${batch.label})`);
                const validation = json.validation;
                if (
                    typeof validation === "object" &&
                    validation !== null &&
                    (validation as { ok?: unknown }).ok === false
                ) {
                    throw new BuildError(`${batch.label}: validation failed: ${JSON.stringify(validation)}`);
                }
                if (typeof json.revn === "number") {
                    this.revn = json.revn;
                }
                this.recordBatch(batch, started);
                return;
            } catch (error) {
                if (!(error instanceof McpToolError) || !error.transient || attempt >= RETRY_DELAYS_MS.length) {
                    throw error;
                }
                this.log(`[build] ${batch.label}: transient failure, checking the file first (${error.message})`);
                if (await batch.verify()) {
                    this.log(`[build] ${batch.label}: the write had already been applied`);
                    this.recordBatch(batch, started);
                    return;
                }
                await delay(RETRY_DELAYS_MS[attempt] ?? 0);
            }
        }
    }

    /**
     * Records and logs the timing of one finished batch.
     *
     * @param batch - the batch that finished
     * @param started - start time from performance.now()
     */
    private recordBatch(batch: WriteBatch, started: number): void {
        const ms = Math.round(performance.now() - started);
        const record: BatchRecord = { label: batch.label, ops: batch.ops.length, ms, revn: this.revn ?? null };
        this.ids.addBatch(record);
        this.log(`[build] ${batch.label}: ${record.ops} ops, ${ms} ms, revn ${record.revn ?? "unknown"}`);
    }

    /**
     * Reads the file outline: its revision and its pages.
     */
    private async readOutline(): Promise<{ revn: number | undefined; pages: { id: string; name: string }[] }> {
        const result = await this.session.call("get_file_outline", { fileId: this.fileId });
        const json = expectRecord(result.json, "get_file_outline");
        const pages = expectArray(json.pages, "pages").map((page) => {
            const record = expectRecord(page, "page");
            return { id: String(record.id), name: String(record.name) };
        });
        return { revn: typeof json.revn === "number" ? json.revn : undefined, pages };
    }

    /**
     * Reads the whole node tree of one page, to depth 20.
     *
     * @param pageId - page to read
     * @throws BuildError when the tree is truncated
     */
    private async readPageTree(pageId: string): Promise<PageTree> {
        const result = await this.session.call("get_page_tree", {
            fileId: this.fileId,
            pageId,
            depth: TREE_DEPTH,
            limit: TREE_LIMIT,
        });
        const json = expectRecord(result.json, "get_page_tree");
        if (json.truncated === true) {
            throw new BuildError(`the tree of page ${pageId} is truncated`);
        }
        const revn = typeof json.revn === "number" ? json.revn : undefined;
        if (revn !== undefined) {
            this.revn = revn;
        }
        return { root: parseTree(json.root), revn };
    }

    /**
     * Reads the library: components, typographies and their ids.
     */
    private async readLibrary(): Promise<Library> {
        const result = await this.session.call("get_library", { fileId: this.fileId });
        const json = expectRecord(result.json, "get_library");
        const components = expectArray(json.components ?? [], "components").map((item) => {
            const record = expectRecord(item, "component");
            return {
                id: String(record.id),
                name: typeof record.name === "string" ? record.name : "",
                path: typeof record.path === "string" ? record.path : "",
                mainInstanceId: String(record.mainInstanceId),
                deleted: record.deleted === true,
            };
        });
        const typographies = expectArray(json.typographies ?? [], "typographies").map((item) => {
            const record = expectRecord(item, "typography");
            return { id: String(record.id), name: String(record.name) };
        });
        return { components, typographies };
    }

    /**
     * Reads the token sets and themes.
     */
    private async readTokens(): Promise<TokenIndex> {
        const result = await this.session.call("get_tokens", { fileId: this.fileId });
        const json = expectRecord(result.json, "get_tokens");
        const sets = expectArray(json.sets ?? [], "sets").map((item) => {
            const record = expectRecord(item, "set");
            return { id: String(record.id), name: String(record.name) };
        });
        const themes = expectArray(json.themes ?? [], "themes").map((item) => {
            const record = expectRecord(item, "theme");
            return { id: String(record.id), name: String(record.name) };
        });
        return { sets, themes };
    }

    /**
     * Tells whether every name is a top-level shape of the page, comparing normalised names.
     *
     * @param pageId - page to read
     * @param names - normalised names to find
     */
    private async hasTopLevelNames(pageId: string, names: readonly string[]): Promise<boolean> {
        const tree = await this.readPageTree(pageId);
        const top = new Set(tree.root.children.map((child) => normalizeName(child.name)));
        return names.every((name) => top.has(name));
    }

    /**
     * Returns the id of a page, or fails when it is not known.
     *
     * @param pageIds - page id by page name
     * @param name - page name
     */
    private requirePage(pageIds: Record<string, string>, name: string): string {
        const pageId = pageIds[name];
        if (pageId === undefined) {
            throw new BuildError(`page "${name}" is not known`);
        }
        return pageId;
    }
}

/**
 * Splits the components into waves. A component joins the first wave in which every component it instantiates is
 * already built.
 *
 * @param specs - all components in page order
 * @returns the waves, first wave first
 */
function componentWaves(specs: readonly ComponentSpec[]): ComponentSpec[][] {
    const waves: ComponentSpec[][] = [];
    const built = new Set<string>();
    let remaining = [...specs];
    while (remaining.length > 0) {
        const ready = remaining.filter((spec) => instanceReferences(spec.root).every((ref) => built.has(ref)));
        if (ready.length === 0) {
            throw new BuildError("the components instantiate each other in a cycle");
        }
        waves.push(ready);
        for (const spec of ready) {
            built.add(normalizeName(spec.name));
        }
        remaining = remaining.filter((spec) => !ready.includes(spec));
    }
    return waves;
}

/**
 * Returns the names of the groups whose operations are in one batch.
 *
 * @param groups - groups of one family or journey
 * @param batch - a batch made from those groups
 */
function namesInBatch(groups: readonly PlannedGroup[], batch: readonly Operation[]): string[] {
    return groups
        .filter((group) => {
            const first = group.ops[0];
            return first !== undefined && batch.includes(first);
        })
        .map((group) => group.topName);
}

/**
 * Joins a library path and a component name with `/`.
 *
 * @param path - library path, possibly empty
 * @param name - component name
 */
function joinPath(path: string, name: string): string {
    return [path, name].filter((part) => part.length > 0).join("/");
}

/**
 * Converts the JSON of a tree node into a typed node, recursively.
 *
 * @param value - parsed JSON of one node
 */
function parseTree(value: unknown): TreeNode {
    const record = expectRecord(value, "tree node");
    const children = record.children === undefined ? [] : expectArray(record.children, "children").map(parseTree);
    return {
        id: String(record.id),
        name: typeof record.name === "string" ? record.name : "",
        children,
    };
}

/**
 * Counts the nodes below a root, the root itself excluded.
 *
 * @param node - root of the subtree
 */
function countNodes(node: TreeNode): number {
    return node.children.reduce((sum, child) => sum + 1 + countNodes(child), 0);
}

/**
 * Walks from the top of a page along the path and returns the node it reaches.
 *
 * @param root - root of the page tree
 * @param path - steps from the top-level shapes down to the target
 * @throws BuildError when a step matches no shape
 */
function resolvePath(root: TreeNode, path: readonly PathStep[]): TreeNode {
    let siblings: readonly TreeNode[] = root.children;
    let found: TreeNode | undefined = undefined;
    for (const step of path) {
        found = siblings.filter((node) => normalizeName(node.name) === step.name)[step.ordinal];
        if (found === undefined) {
            throw new BuildError(`shape "${step.name}" (occurrence ${step.ordinal}) was not found on the page`);
        }
        siblings = found.children;
    }
    if (found === undefined) {
        throw new BuildError("empty override path");
    }
    return found;
}

/**
 * Finds the first descendant with the given name, searching depth first.
 *
 * @param node - node to search below
 * @param name - name to find, compared after normalisation
 */
function findDescendant(node: TreeNode, name: string): TreeNode | undefined {
    const wanted = normalizeName(name);
    for (const child of node.children) {
        if (normalizeName(child.name) === wanted) {
            return child;
        }
        const nested = findDescendant(child, name);
        if (nested !== undefined) {
            return nested;
        }
    }
    return undefined;
}
