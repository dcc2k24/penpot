import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { Tool } from "../../Tool";
import type { BackendServices } from "../../backend/BackendServices";
import { WhoamiTool } from "./WhoamiTool";
import { ListTeamsTool } from "./ListTeamsTool";
import { ListProjectsTool } from "./ListProjectsTool";
import { ListFilesTool } from "./ListFilesTool";
import { GetFileOutlineTool } from "./GetFileOutlineTool";
import { GetPageTreeTool } from "./GetPageTreeTool";
import { GetShapesTool } from "./GetShapesTool";
import { FindShapesTool } from "./FindShapesTool";
import { GetLibraryTool } from "./GetLibraryTool";
import { GetTokensTool } from "./GetTokensTool";
import { ApplyOperationsTool } from "./ApplyOperationsTool";
import { BatchCreateShapesTool } from "./BatchCreateShapesTool";
import { ApplyRawChangesTool } from "./ApplyRawChangesTool";
import { ManageFilesTool } from "./ManageFilesTool";
import { ManageVersionsTool } from "./ManageVersionsTool";
import { CommentsTool } from "./CommentsTool";
import { ImportImageBackendTool } from "./ImportImageBackendTool";
import { ImportSvgBackendTool } from "./ImportSvgBackendTool";
import { ImportArchiveBackendTool } from "./ImportArchiveBackendTool";
import { ExportShapeBackendTool } from "./ExportShapeBackendTool";
import { ExecuteCodeBackendTool } from "./ExecuteCodeBackendTool";

/** Creates the backend-mode tools that share one set of backend services. */
export class BackendToolSet {
    /**
     * Creates every backend-mode tool.
     *
     * @param mcpServer - the MCP server the tools belong to
     * @param services - the backend, validator, rate limiter and write queue shared by the tools
     */
    public static create(mcpServer: PenpotMcpServer, services: BackendServices): Tool<any>[] {
        return [
            new WhoamiTool(mcpServer, services),
            new ListTeamsTool(mcpServer, services),
            new ListProjectsTool(mcpServer, services),
            new ListFilesTool(mcpServer, services),
            new GetFileOutlineTool(mcpServer, services),
            new GetPageTreeTool(mcpServer, services),
            new GetShapesTool(mcpServer, services),
            new FindShapesTool(mcpServer, services),
            new GetLibraryTool(mcpServer, services),
            new GetTokensTool(mcpServer, services),
            new ApplyOperationsTool(mcpServer, services),
            new BatchCreateShapesTool(mcpServer, services),
            new ApplyRawChangesTool(mcpServer, services),
            new ManageFilesTool(mcpServer, services),
            new ManageVersionsTool(mcpServer, services),
            new CommentsTool(mcpServer, services),
            new ImportImageBackendTool(mcpServer, services),
            new ImportSvgBackendTool(mcpServer, services),
            new ImportArchiveBackendTool(mcpServer, services),
            new ExportShapeBackendTool(mcpServer, services),
            new ExecuteCodeBackendTool(mcpServer, services),
        ];
    }
}
