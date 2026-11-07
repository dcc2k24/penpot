import { EmptyToolArgs } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";

/** Reports the profile, scopes and backend version behind the MCP token. */
export class WhoamiTool extends BackendTool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, EmptyToolArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "whoami";
    }

    public getToolDescription(): string {
        return (
            "Returns the Penpot profile, the scopes (mcp:read, mcp:write, mcp:manage, mcp:delete) and the " +
            "backend version behind the MCP token. Call it first to learn which operations the token allows. " +
            "Next: list_teams."
        );
    }

    protected async executeBackend(_args: EmptyToolArgs, userToken: string): Promise<ToolResponse> {
        return this.jsonResponse(await this.callCommand(userToken, "mcp-whoami", {}));
    }
}
