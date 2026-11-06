import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** Arguments of {@link GetFileOutlineTool}. */
export class GetFileOutlineArgs {
    static schema = {
        fileId: BackendIds.uuid().describe(
            "Id of the file, as returned by list_files. Every later call names it explicitly."
        ),
    };

    fileId!: string;
}

/** Returns the pages, libraries and counts of a file, with the current revision. */
export class GetFileOutlineTool extends BackendTool<GetFileOutlineArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, GetFileOutlineArgs.schema, services);
    }

    public getToolName(): string {
        return "get_file_outline";
    }

    public getToolDescription(): string {
        return (
            "Returns a file's outline: its pages with ids and shape counts, its linked libraries, component, " +
            "color and token counts, and the revision (revn) to pass as baseRevn to writes. " +
            "Next: get_page_tree with a fileId and a pageId."
        );
    }

    protected async executeBackend(args: GetFileOutlineArgs, userToken: string): Promise<ToolResponse> {
        return this.jsonResponse(await this.callCommand(userToken, "get-mcp-file-outline", { fileId: args.fileId }));
    }
}
