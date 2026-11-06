import { EmptyToolArgs } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";

/** Lists the teams the token's profile belongs to. */
export class ListTeamsTool extends BackendTool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, EmptyToolArgs.schema, services);
    }

    public getToolName(): string {
        return "list_teams";
    }

    public getToolDescription(): string {
        return (
            "Lists the teams of the profile with their ids. Team ids are the explicit handle for every later " +
            "call that needs a team. Next: list_projects with a teamId."
        );
    }

    protected async executeBackend(_args: EmptyToolArgs, userToken: string): Promise<ToolResponse> {
        return this.jsonResponse(await this.callCommand(userToken, "get-teams", {}));
    }
}
