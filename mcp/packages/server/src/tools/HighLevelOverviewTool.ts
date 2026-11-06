import { EmptyToolArgs, Tool } from "../Tool";
import "reflect-metadata";
import type { ToolResponse } from "../ToolResponse";
import { TextResponse } from "../ToolResponse";
import type { PenpotMcpServer } from "../PenpotMcpServer";

/**
 * Returns the high-level overview that matches the server mode.
 *
 * In `bridge` mode the overview covers the plugin tools, in `backend` mode the backend tools, and in `both`
 * mode both, in separate sections.
 */
export class HighLevelOverviewTool extends Tool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer) {
        super(mcpServer, EmptyToolArgs.schema);
    }

    public getToolName(): string {
        return "high_level_overview";
    }

    public getToolDescription(): string {
        return (
            "Returns basic high-level instructions on the usage of Penpot-related tools and the Penpot API. " +
            "If you have already read the 'Penpot High-Level Overview', you must not call this tool."
        );
    }

    protected async executeCore(args: EmptyToolArgs): Promise<ToolResponse> {
        return new TextResponse(this.overview());
    }

    /**
     * Assembles the overview text of the current server mode.
     */
    private overview(): string {
        switch (this.mcpServer.getMode()) {
            case "bridge":
                return this.mcpServer.getHighLevelOverviewInstructions();
            case "backend":
                return this.mcpServer.getBackendInstructions();
            case "both":
                return (
                    "=== Backend tools: whoami, list_files, apply_operations and the other tools without a suffix ===\n\n" +
                    this.mcpServer.getBackendInstructions() +
                    "\n\n=== Plugin bridge tools: execute_code_in_tab, export_shape_from_tab, import_image_in_tab ===\n\n" +
                    this.mcpServer.getHighLevelOverviewInstructions()
                );
        }
    }
}
