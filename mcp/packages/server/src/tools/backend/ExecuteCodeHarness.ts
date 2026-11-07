import type { RecordedCall } from "../../backend/testing/FakePenpotBackend";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import { BackendSettings } from "../../backend/BackendSettings";
import { BackendServices } from "../../backend/BackendServices";
import { FakeExporterClient } from "../../backend/testing/FakeExporterClient";
import { FakePenpotBackend, type CannedResponse } from "../../backend/testing/FakePenpotBackend";
import { ExecuteCodeBackendTool } from "./ExecuteCodeBackendTool";

/** Token of the scenario user. */
export const TOKEN = "dana-token";
/** File the scenarios work on. */
export const FILE = "1b2c3d4e-0000-4000-8000-000000000011";
/** Page of the scenario file. */
export const PAGE = "1b2c3d4e-0000-4000-8000-000000000012";
/** Root frame of every page. */
export const ROOT = "00000000-0000-0000-0000-000000000000";
/** Team of the scenario file. */
export const TEAM = "3d4e5f60-0000-4000-8000-0000000000b1";
/** Second page of the scenario file, for cross-page checks. */
export const PAGE_TWO = "1b2c3d4e-0000-4000-8000-000000000013";

/** A shape of the fake page, as the backend names it. Any other member is copied into its record. */
export interface FakeShape {
    id: string;
    type: string;
    name: string;
    /** Parent shape id; the root when omitted. */
    parentId?: string;
    [key: string]: unknown;
}

/** An operation of a recorded write. */
export type Op = Record<string, unknown>;

/** Options of {@link harness}. */
export interface HarnessOptions {
    /** Backend settings of the services. */
    settings?: BackendSettings;
    /** Shapes of the fake page. */
    shapes?: FakeShape[];
    /** Answers of backend commands, which replace the defaults. */
    responses?: Record<string, CannedResponse>;
}

/** The fakes and the tool built by {@link harness}. */
export interface Harness {
    backend: FakePenpotBackend;
    exporter: FakeExporterClient;
    services: BackendServices;
    tool: ExecuteCodeBackendTool;
}

/** Every service set built by the harness, disposed by {@link disposeHarnesses}. */
const allServices: BackendServices[] = [];

/** A server stub whose only job is to return the request session. */
export function sessionServer(userToken: string): PenpotMcpServer {
    return {
        getSessionContext: () => ({ userToken }),
        isFileSystemAccessEnabled: () => false,
    } as unknown as PenpotMcpServer;
}

/**
 * Builds the records of the fake page: a root that holds the top-level shapes, and one record per shape with its
 * children listed in order.
 *
 * @param shapes - shapes of the page, each under its parent or under the root
 * @returns the records by id
 */
export function pageRecords(shapes: FakeShape[]): Map<string, Record<string, unknown>> {
    const records = new Map<string, Record<string, unknown>>();
    const childrenOf = (parent: string): string[] =>
        shapes.filter((shape) => (shape.parentId ?? ROOT) === parent).map((shape) => shape.id);
    records.set(ROOT, {
        id: ROOT,
        type: "frame",
        name: "Root",
        parentId: null,
        frameId: ROOT,
        shapes: childrenOf(ROOT),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        fills: [],
    });
    for (const shape of shapes) {
        const parent = shape.parentId ?? ROOT;
        records.set(shape.id, {
            x: 0,
            y: 0,
            width: 50,
            height: 50,
            fills: [],
            ...shape,
            parentId: parent,
            frameId: parent,
            shapes: childrenOf(shape.id),
        });
    }
    return records;
}

/**
 * Builds the page tree of the fake page from the records: each node lists its children.
 *
 * @param shapes - shapes of the page
 * @returns the root node
 */
export function pageTree(shapes: FakeShape[]): { id: string; children: unknown[] } {
    const build = (id: string): { id: string; children: unknown[] } => ({
        id,
        children: shapes.filter((shape) => (shape.parentId ?? ROOT) === id).map((shape) => build(shape.id)),
    });
    return build(ROOT);
}

/**
 * Answers a write the way the backend does: every temporary handle maps to a fake uuid.
 *
 * @param params - the parameters of the write
 * @param revn - the revn the file has after the write
 * @returns the write result
 */
export function applyResult(params: object, revn: number): unknown {
    const operations = (params as { operations: Op[] }).operations;
    const createdIds: Record<string, string> = {};
    for (const operation of operations) {
        const id = operation.id;
        if (typeof id === "string" && id.startsWith("$tmp:")) {
            createdIds[id] = "uuid-" + id.slice("$tmp:".length);
        }
    }
    return { revn, createdIds, warnings: [], changeCount: operations.length };
}

/** The shape type that each create operation makes in the fake page. */
const CREATED_TYPES: Record<string, string> = {
    create_board: "frame",
    create_rect: "rect",
    create_ellipse: "circle",
};

/**
 * Stores the effect of one write on the shapes of the fake page: a create adds a shape under its parent, and an
 * update merges its props. Handles map to the ids the write gave them.
 *
 * @param shapes - shapes of the fake page, changed in place
 * @param operations - the operations of the write
 * @param createdIds - ids of the handles that the write created
 */
export function applyToShapes(shapes: FakeShape[], operations: Op[], createdIds: Record<string, string>): void {
    const resolve = (value: unknown): unknown =>
        typeof value === "string" && createdIds[value] !== undefined ? createdIds[value] : value;
    for (const operation of operations) {
        const type = CREATED_TYPES[operation.op as string];
        if (type !== undefined) {
            const shape: FakeShape = {
                id: resolve(operation.id) as string,
                type,
                name: typeof operation.name === "string" ? operation.name : type,
                parentId: (resolve(operation.parentId) as string | undefined) ?? ROOT,
            };
            for (const key of ["x", "y", "width", "height"]) {
                if (typeof operation[key] === "number") {
                    shape[key] = operation[key];
                }
            }
            shapes.push(shape);
        } else if (operation.op === "update_shape") {
            const shape = shapes.find((candidate) => candidate.id === resolve(operation.id));
            if (shape !== undefined && typeof operation.props === "object" && operation.props !== null) {
                Object.assign(shape, operation.props);
            }
        }
    }
}

/**
 * Builds the fake backend and the tool. The backend accepts every token and echoes the created ids of each write.
 *
 * @param options - shapes, settings and answers of the scenario
 * @returns the fakes and the tool
 */
export function harness(options: HarnessOptions = {}): Harness {
    // the shapes of the fake page; a write adds to them, so a later page read sees what the write created.
    const shapes: FakeShape[] = [...(options.shapes ?? [])];
    // the revn of the fake file, advanced by every write so that page reads report the latest one.
    let revn = 1;
    const backend = new FakePenpotBackend()
        .respond("mcp-whoami", {
            contractVersion: 1,
            profileId: "profile-1",
            scopes: ["mcp:read", "mcp:write", "mcp:manage", "mcp:delete"],
        })
        .respond("get-mcp-file-outline", {
            id: FILE,
            name: "Scenario file",
            teamId: TEAM,
            revn: 1,
            pages: [
                { id: PAGE, name: "Page 1", index: 0 },
                { id: PAGE_TWO, name: "Page 2", index: 1 },
            ],
        })
        .respond("get-mcp-page-tree", () => ({
            revn,
            pageId: PAGE,
            root: pageTree(shapes),
            truncated: false,
        }))
        .respond("get-mcp-shapes", (params: object) => {
            const ids = (params as { ids: string[] }).ids;
            const records = pageRecords(shapes);
            return {
                revn,
                shapes: ids.filter((id) => records.has(id)).map((id) => records.get(id)),
                missing: ids.filter((id) => !records.has(id)),
            };
        })
        .respond("get-mcp-tokens", { sets: [], themes: [], tokens: [], activeThemes: [], activeSets: [] })
        .respond("get-mcp-library", { components: [], colors: [], typographies: [] })
        .respond("create-mcp-render-session", {
            token: "render-1",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .respond("create-file-media-object-from-url", {
            id: "media-url-1",
            name: "pic",
            width: 4,
            height: 2,
            mtype: "image/png",
        })
        .respond("upload-file-media-object", {
            id: "media-upload-1",
            name: "pic",
            width: 4,
            height: 2,
            mtype: "image/png",
        })
        .respond("mcp-apply-operations", (params: object) => {
            revn += 1;
            const result = applyResult(params, revn) as { createdIds: Record<string, string> };
            applyToShapes(shapes, (params as { operations: Op[] }).operations, result.createdIds);
            return result;
        });
    for (const [name, response] of Object.entries(options.responses ?? {})) {
        backend.respond(name, response);
    }
    const exporter = new FakeExporterClient();
    const services = new BackendServices(backend, options.settings ?? new BackendSettings(), exporter);
    allServices.push(services);
    return { backend, exporter, services, tool: new ExecuteCodeBackendTool(sessionServer(TOKEN), services) };
}

/**
 * Runs a script on the test file.
 *
 * @param tool - the execute_code tool
 * @param code - the script
 * @param extra - other arguments of the call, such as write options
 * @returns the tool response
 */
export function run(
    tool: ExecuteCodeBackendTool,
    code: string,
    extra: Record<string, unknown> = {}
): Promise<ToolResponse> {
    return tool.execute({ code, fileId: FILE, ...extra });
}

/**
 * Returns the text of a text response.
 *
 * @param response - the response
 */
export function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/**
 * Returns the operations of one recorded write.
 *
 * @param call - the recorded write
 */
export function opsOf(call: RecordedCall): Op[] {
    return (call.params as { operations: Op[] }).operations;
}

/**
 * Returns the operation names of one recorded write, in order.
 *
 * @param call - the recorded write
 */
export function opNamesOf(call: RecordedCall): string[] {
    return opsOf(call).map((operation) => operation.op as string);
}

/** Disposes the services of every harness built so far, so that the process can exit. */
export function disposeHarnesses(): void {
    for (const services of allServices) {
        services.sandboxes.dispose();
    }
}
