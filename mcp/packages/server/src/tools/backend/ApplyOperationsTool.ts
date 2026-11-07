import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { TokenDigest } from "../../backend/TokenDigest";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";
import { TokenCatalogueCache } from "./TokenCatalogueCache";
import { WriteOptions } from "./WriteOptions";
import { OPERATION_NAMES } from "./operations/OperationSchemas";
import { OperationValidator } from "./operations/OperationValidator";
import { ApplyTokenValues, TokenCatalogue, type TokenValueWarning } from "../../sandbox/ApplyTokenValues";

/** Arguments of {@link ApplyOperationsTool}. */
export class ApplyOperationsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file to change, from list_files."),
        operations: z
            .array(
                z.looseObject({
                    op: z.string().describe("Operation name, such as create_rect, update_shape or set_text."),
                })
            )
            .min(1)
            .max(OperationValidator.MAX_OPERATIONS)
            .describe(
                "Operations applied in order, each an object with an op name and camelCase parameters. " +
                    "A create operation may set id to a $tmp:name handle that later operations use. " +
                    "Unknown ops and missing parameters are reported with the valid names and fields."
            ),
        allowSplit: z
            .boolean()
            .optional()
            .describe(
                "Kept for older clients. Batches are cut by size on the backend and all commit in one " +
                    "transaction; a failed call changes nothing. Default false."
            ),
        ...WriteOptions.schema,
    };

    fileId!: string;

    operations!: Record<string, unknown>[];

    allowSplit?: boolean;

    dryRun?: boolean;

    snapshot?: boolean;

    baseRevn?: number;

    failOnConflict?: boolean;

    requestId?: string;
}

/**
 * Applies a list of typed design operations to a file in one write.
 *
 * Inside the write queue, every `apply_token` operation without `resolvedValue` gets the token's value from the
 * file's token catalogue, and then the batch is validated. Running both there means a token write queued before
 * this call is seen. A supplied value is kept, with a warning in the result when it is not the token's value.
 */
export class ApplyOperationsTool extends BackendTool<ApplyOperationsArgs> {
    /** How long a token catalogue is kept, in milliseconds, while the file does not change. */
    private static readonly CATALOGUE_TTL_MS = 30_000;

    private readonly validator = new OperationValidator();

    private readonly tokenValues = new ApplyTokenValues(
        "apply_operations",
        " Fix the token, or pass resolvedValue to set the value yourself."
    );

    private readonly catalogues: TokenCatalogueCache;

    /**
     * Creates the tool.
     *
     * @param mcpServer - The MCP server instance
     * @param services - backend, validator, rate limiter and write queue shared by all backend tools
     * @param now - clock in milliseconds for the token catalogue cache, injectable for tests
     */
    constructor(mcpServer: PenpotMcpServer, services: BackendServices, now: () => number = Date.now) {
        super(mcpServer, ApplyOperationsArgs.schema, services);
        this.catalogues = new TokenCatalogueCache(ApplyOperationsTool.CATALOGUE_TTL_MS, now);
    }

    public getToolName(): string {
        return "apply_operations";
    }

    public getToolDescription(): string {
        return (
            "Applies typed design operations to a file in one atomic write. Preferred over apply_raw_changes. " +
            "Ids are explicit UUIDs from get_page_tree or get_shapes. " +
            "Use $tmp:name handles to refer to shapes created earlier in the same call; the response maps them to UUIDs. " +
            "Set dryRun true to validate without saving. Pass baseRevn from get_file_outline to detect concurrent edits. " +
            "Shape params are camelCase: pageId, parentId, x, y, width, height, props (fills, strokes, radius, ...). " +
            `Ops: ${OPERATION_NAMES.join(", ")}. ` +
            'Example: {op: create_rect, pageId, id: "$tmp:bg", x: 0, y: 0, width: 100, height: 40, props: {fills: [{fillColor: "#ff0000", fillOpacity: 1}]}}. ' +
            "Call describe_operations with op names to read their parameters when one is rejected."
        );
    }

    protected async executeBackend(args: ApplyOperationsArgs, userToken: string): Promise<ToolResponse> {
        const { result, tokenWarnings } = await this.queueWrite(
            userToken,
            args.fileId,
            () => this.applyInQueue(args, userToken),
            args.dryRun !== true
        );
        return this.jsonResponse(
            WriteOptions.withAlreadyApplied(ApplyOperationsTool.withWarnings(result, tokenWarnings))
        );
    }

    /**
     * Fills the token values and validates the batch, then sends it to the backend.
     *
     * Runs in the write queue of the file, so the catalogue read sees the writes queued before this call.
     *
     * @param args - the validated tool arguments
     * @param userToken - the MCP token of the request
     * @returns the backend result and the token warnings of the batch
     * @throws Error when a token cannot be resolved or an operation is invalid, before anything is sent
     */
    private async applyInQueue(
        args: ApplyOperationsArgs,
        userToken: string
    ): Promise<{ result: unknown; tokenWarnings: TokenValueWarning[] }> {
        const key = `${TokenDigest.sha256Hex(userToken)}:${args.fileId}`;
        const catalogue = this.catalogues.get(
            key,
            this.writeCount(userToken, args.fileId),
            () => new TokenCatalogue(this.services.backend, userToken, args.fileId)
        );
        const tokenWarnings = await this.tokenValues.fill(args.operations, catalogue);
        const operations = this.validator.validate(args.operations);
        const params = {
            fileId: args.fileId,
            operations,
            ...(args.allowSplit !== undefined ? { allowSplit: args.allowSplit } : {}),
            ...WriteOptions.toParams(args),
        };
        const result = await this.callCommand(userToken, "mcp-apply-operations", params);
        return { result, tokenWarnings };
    }

    /**
     * Adds the token value warnings to the warnings of the backend result.
     *
     * @param result - the backend result of the write
     * @param tokenWarnings - the warnings about supplied token values
     * @returns the result itself when there is no token warning, otherwise a copy whose `warnings` list ends with
     *   the token warnings
     */
    private static withWarnings(result: unknown, tokenWarnings: TokenValueWarning[]): unknown {
        if (tokenWarnings.length === 0) {
            return result;
        }
        if (result === null || typeof result !== "object" || Array.isArray(result)) {
            return { result, warnings: tokenWarnings };
        }
        const record = result as Record<string, unknown>;
        const warnings = Array.isArray(record.warnings) ? record.warnings : [];
        return { ...record, warnings: [...warnings, ...tokenWarnings] };
    }
}
