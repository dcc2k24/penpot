import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link GetTokensTool}. */
export class GetTokensArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        resolve: z
            .boolean()
            .optional()
            .describe("Reserved for resolved token values. The server currently returns the raw values."),
    };

    fileId!: string;

    resolve?: boolean;
}

/** Returns the token sets, themes and tokens of a file. */
export class GetTokensTool extends BackendTool<GetTokensArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetTokensArgs.schema, services);
    }

    public getToolName(): string {
        return "get_tokens";
    }

    public getToolDescription(): string {
        return (
            "Returns the design tokens of a file: token sets, themes, the active sets and themes, every token with " +
            "its set id, type and value, and the DTCG export. Token names are how apply_operations refers to them. " +
            "Next: apply_operations with apply_token."
        );
    }

    protected async executeBackend(args: GetTokensArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            ...(args.resolve !== undefined ? { resolve: args.resolve } : {}),
        };
        return this.jsonResponse(await this.callCommand(userToken, "get-mcp-tokens", params));
    }
}
