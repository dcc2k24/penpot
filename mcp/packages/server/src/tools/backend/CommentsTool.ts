import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { BackendIds } from "./BackendIds";

/** The actions of {@link CommentsTool}. */
export type CommentsAction =
    "list" | "get" | "create_thread" | "reply" | "resolve" | "reopen" | "move" | "delete_thread" | "delete";

/** Arguments of {@link CommentsTool}. Each action names the fields it needs. */
export class CommentsArgs {
    static schema = {
        fileId: BackendIds.uuid().describe("Id of the file, from list_files."),
        action: z
            .enum(["list", "get", "create_thread", "reply", "resolve", "reopen", "move", "delete_thread", "delete"])
            .describe(
                "What to do: list (all threads of the file); get (threadId); create_thread (pageId, position, " +
                    "content, optional frameId); reply (threadId, content); resolve or reopen (threadId); " +
                    "move (threadId, position, optional frameId); delete_thread (threadId); delete (commentId)."
            ),
        threadId: BackendIds.uuid().optional().describe("Thread id, from list or get."),
        commentId: BackendIds.uuid().optional().describe("Comment id, from get."),
        pageId: BackendIds.uuid().optional().describe("Page the new thread is pinned to."),
        frameId: BackendIds.uuid()
            .optional()
            .describe("Frame (board) the thread is pinned to. Omit it to pin the thread to the page background."),
        position: z
            .object({
                x: z.number().describe("Absolute x coordinate on the page."),
                y: z.number().describe("Absolute y coordinate on the page."),
            })
            .optional()
            .describe("Page position of the thread."),
        content: z.string().min(1).max(4000).optional().describe("Text of the thread's first comment or of a reply."),
    };

    fileId!: string;

    action!: CommentsAction;

    threadId?: string;

    commentId?: string;

    pageId?: string;

    frameId?: string;

    position?: { x: number; y: number };

    content?: string;
}

/** Lists, creates, answers, resolves, moves and deletes comment threads of a file. */
export class CommentsTool extends BackendTool<CommentsArgs> {
    /** Frame id of the page background, which a thread uses when the caller names no frame. */
    private static readonly ROOT_FRAME_ID = "00000000-0000-0000-0000-000000000000";

    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, CommentsArgs.schema, services);
    }

    public getToolName(): string {
        return "comments";
    }

    public getToolDescription(): string {
        return (
            "Works with comment threads on a file: list threads, get one with its comments, create a thread at a " +
            "position, reply, resolve or reopen, move, and delete threads or single comments. " +
            "The frameId names the frame (board) a thread is pinned to; omit it to pin the thread to the page " +
            "background. Start with list to find threadId values."
        );
    }

    protected async executeBackend(args: CommentsArgs, userToken: string): Promise<ToolResponse> {
        const result = await this.run(args, userToken);
        return this.jsonResponse(result ?? { status: "ok" });
    }

    /**
     * Runs the command of one action.
     *
     * @param args - the tool arguments
     * @param userToken - the MCP token of the request
     * @throws Error when the action needs a field that is missing
     */
    private run(args: CommentsArgs, userToken: string): Promise<unknown> {
        const fileId = args.fileId;
        switch (args.action) {
            case "list":
                return this.callCommand(userToken, "get-comment-threads", { fileId });
            case "get":
                return this.callCommand(userToken, "get-comments", { threadId: this.need(args, "threadId") });
            case "create_thread":
                return this.callWrite(userToken, fileId, "create-comment-thread", {
                    fileId,
                    pageId: this.need(args, "pageId"),
                    frameId: args.frameId ?? CommentsTool.ROOT_FRAME_ID,
                    position: this.needPosition(args),
                    content: this.need(args, "content"),
                });
            case "reply":
                return this.callWrite(userToken, fileId, "create-comment", {
                    threadId: this.need(args, "threadId"),
                    content: this.need(args, "content"),
                });
            case "resolve":
            case "reopen":
                return this.callWrite(userToken, fileId, "update-comment-thread", {
                    id: this.need(args, "threadId"),
                    isResolved: args.action === "resolve",
                });
            case "move":
                return this.callWrite(userToken, fileId, "update-comment-thread-position", {
                    id: this.need(args, "threadId"),
                    position: this.needPosition(args),
                    frameId: args.frameId ?? CommentsTool.ROOT_FRAME_ID,
                });
            case "delete_thread":
                return this.callWrite(userToken, fileId, "delete-comment-thread", {
                    id: this.need(args, "threadId"),
                });
            case "delete":
                return this.callWrite(userToken, fileId, "delete-comment", { id: this.need(args, "commentId") });
        }
    }

    /**
     * Returns a string field that the action needs.
     *
     * @param args - the tool arguments
     * @param field - name of the field
     * @throws Error when the field is missing
     */
    private need(args: CommentsArgs, field: "threadId" | "commentId" | "pageId" | "content"): string {
        const value = args[field];
        if (value === undefined) {
            throw new Error(`comments action "${args.action}" needs ${field}.`);
        }
        return value;
    }

    /**
     * Returns the position that the action needs.
     *
     * @param args - the tool arguments
     * @throws Error when the position is missing
     */
    private needPosition(args: CommentsArgs): { x: number; y: number } {
        if (!args.position) {
            throw new Error(`comments action "${args.action}" needs position.`);
        }
        return args.position;
    }
}
