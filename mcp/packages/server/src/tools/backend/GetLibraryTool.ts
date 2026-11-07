import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link GetLibraryTool}. */
export class GetLibraryArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file that owns the library, from list_files."),
        kinds: z
            .array(z.enum(["components", "colors", "typographies", "media"]))
            .optional()
            .describe("Parts of the library to return. Default: all four."),
        includeDeleted: z.boolean().optional().describe("When true, include deleted components."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(5000)
            .optional()
            .describe("Maximum number of entries per kind (1 to 5000, default 500)."),
    };

    fileId!: string;

    kinds?: ("components" | "colors" | "typographies" | "media")[];

    includeDeleted?: boolean;

    limit?: number;
}

/** Returns the components, colors, typographies and media of a file's library. */
export class GetLibraryTool extends BackendTool<GetLibraryArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetLibraryArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "get_library";
    }

    public getToolDescription(): string {
        return (
            "Returns the library of a file: components (with main instance ids and variant data), colors, " +
            "typographies and media. Use the ids to instantiate components or apply typographies. " +
            "Next: apply_operations with instantiate_component, or get_tokens for design tokens."
        );
    }

    protected async executeBackend(args: GetLibraryArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            ...(args.kinds !== undefined ? { kinds: args.kinds } : {}),
            ...(args.includeDeleted !== undefined ? { includeDeleted: args.includeDeleted } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };
        return this.jsonResponse(await this.callCommand(userToken, "get-mcp-library", params));
    }
}
