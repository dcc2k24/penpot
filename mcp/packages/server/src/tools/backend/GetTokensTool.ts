import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link GetTokensTool}. */
export class GetTokensArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        setId: BackendIds.uuid()
            .optional()
            .describe("Id of one token set, from an earlier get_tokens answer. Leave it out for every set."),
        format: z
            .enum(["tokens", "dtcg"])
            .optional()
            .describe(
                "tokens (default): the sets, themes and every token with its set id, type and value. " +
                    "dtcg: the same tokens as a DTCG export instead. Only one of the two comes back."
            ),
    };

    fileId!: string;

    setId?: string;

    format?: "tokens" | "dtcg";
}

/** Returns the token sets, themes and tokens of a file. */
export class GetTokensTool extends BackendTool<GetTokensArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetTokensArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "get_tokens";
    }

    public getToolDescription(): string {
        return (
            "Returns the design tokens of a file: token sets, themes, the active sets and themes, and every token " +
            "with its set id, type and value. Pass setId to get the tokens of one set, and format dtcg to get the " +
            "DTCG export instead. Token names are how apply_operations refers to them. " +
            "Next: apply_operations with apply_token."
        );
    }

    protected async executeBackend(args: GetTokensArgs, userToken: string): Promise<ToolResponse> {
        const params = {
            fileId: args.fileId,
            ...(args.setId !== undefined ? { setId: args.setId } : {}),
            format: args.format ?? "tokens",
        };
        return this.jsonResponse(await this.callCommand(userToken, "get-mcp-tokens", params));
    }
}
