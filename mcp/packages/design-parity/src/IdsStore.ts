import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IDS_FILE } from "./Paths.js";

/**
 * Timing of one write batch, kept in the output record.
 */
export interface BatchRecord {
    readonly label: string;
    readonly ops: number;
    readonly ms: number;
    readonly revn: number | null;
}

/**
 * Ids of one main component: its root shape and its library component.
 */
export interface ComponentIds {
    readonly mainBoardId: string;
    readonly componentId: string;
}

/**
 * Shape of `out/ids.json`. Every field is filled as the build goes on.
 */
export interface IdsRecord {
    fileId: string | null;
    projectId: string | null;
    pages: Record<string, string>;
    components: Record<string, ComponentIds>;
    typographies: Record<string, string>;
    tokens: { setId?: string; themeId?: string };
    screens: Record<string, string>;
    nodeCount: Record<string, number>;
    batches: BatchRecord[];
}

/**
 * Writes `out/ids.json` each time a part of the record changes, so a failed build keeps what it created.
 */
export class IdsStore {
    private readonly path: string;
    private record: IdsRecord;

    /**
     * Creates an empty store that writes to the given path.
     *
     * @param path - file the record is written to
     */
    constructor(path: string = IDS_FILE) {
        this.path = path;
        this.record = emptyRecord();
    }

    /**
     * Reads the file id recorded by an earlier build.
     *
     * @param path - file the record was written to
     * @returns the recorded file id, or undefined when there is no usable record
     */
    static readRecordedFileId(path: string = IDS_FILE): string | undefined {
        if (!existsSync(path)) {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (typeof parsed === "object" && parsed !== null && "fileId" in parsed) {
                const fileId = (parsed as { fileId: unknown }).fileId;
                return typeof fileId === "string" ? fileId : undefined;
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    /**
     * Starts a new record for a newly created file and writes it.
     *
     * @param fileId - id of the new file
     * @param projectId - project the file was created in
     */
    reset(fileId: string, projectId: string): void {
        this.record = emptyRecord();
        this.record.fileId = fileId;
        this.record.projectId = projectId;
        this.save();
    }

    /**
     * Records the id of a page.
     *
     * @param name - page name
     * @param id - page id
     */
    setPage(name: string, id: string): void {
        this.record.pages[name] = id;
        this.save();
    }

    /**
     * Records the ids of a main component.
     *
     * @param fullName - normalised full component name
     * @param ids - root shape id and library component id
     */
    setComponent(fullName: string, ids: ComponentIds): void {
        this.record.components[fullName] = ids;
        this.save();
    }

    /**
     * Records the id of a typography.
     *
     * @param name - typography name
     * @param id - library typography id
     */
    setTypography(name: string, id: string): void {
        this.record.typographies[name] = id;
        this.save();
    }

    /**
     * Records the ids of the token set and the theme.
     *
     * @param setId - id of the `core` token set
     * @param themeId - id of the `light` theme
     */
    setTokens(setId: string, themeId: string): void {
        this.record.tokens = { setId, themeId };
        this.save();
    }

    /**
     * Records the board id of a journey screen.
     *
     * @param fullName - full screen name
     * @param id - root board id
     */
    setScreen(fullName: string, id: string): void {
        this.record.screens[fullName] = id;
        this.save();
    }

    /**
     * Records the node count of a page, root excluded.
     *
     * @param pageName - page name
     * @param count - number of nodes
     */
    setNodeCount(pageName: string, count: number): void {
        this.record.nodeCount[pageName] = count;
        this.save();
    }

    /**
     * Appends the timing of one write batch.
     *
     * @param batch - the batch record
     */
    addBatch(batch: BatchRecord): void {
        this.record.batches.push(batch);
        this.save();
    }

    /**
     * Returns a copy of the record for reporting.
     */
    snapshot(): IdsRecord {
        return structuredClone(this.record);
    }

    /**
     * Writes the record to disk, creating the output folder when needed.
     */
    private save(): void {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, `${JSON.stringify(this.record, null, 2)}\n`, "utf8");
    }
}

/**
 * Returns a record with every collection empty.
 */
function emptyRecord(): IdsRecord {
    return {
        fileId: null,
        projectId: null,
        pages: {},
        components: {},
        typographies: {},
        tokens: {},
        screens: {},
        nodeCount: {},
        batches: [],
    };
}
