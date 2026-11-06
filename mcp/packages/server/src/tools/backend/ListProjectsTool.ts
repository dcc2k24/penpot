import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link ListProjectsTool}. */
export class ListProjectsArgs {
    static schema = {
        teamId: BackendIds.uuid().describe("Id of the team whose projects to list, as returned by list_teams."),
    };

    teamId!: string;
}

/** Lists the projects of one team. */
export class ListProjectsTool extends BackendTool<ListProjectsArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, ListProjectsArgs.schema, services);
    }

    public getToolName(): string {
        return "list_projects";
    }

    public getToolDescription(): string {
        return (
            "Lists the projects of a team with their ids. Pass a teamId from list_teams. " +
            "Deleted files are listed with list_files, a teamId and deleted: true. " +
            "Next: list_files with a projectId."
        );
    }

    protected async executeBackend(args: ListProjectsArgs, userToken: string): Promise<ToolResponse> {
        return this.jsonResponse(await this.callCommand(userToken, "get-projects", { teamId: args.teamId }));
    }
}
