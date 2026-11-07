import { z } from "zod";
import type { PenpotMcpServer } from "../../PenpotMcpServer";
import type { ToolAnnotations } from "../../Tool";
import type { ToolResponse } from "../../ToolResponse";
import type { BackendServices } from "../../backend/BackendServices";
import { BackendTool } from "./BackendTool";
import { OPERATION_NAMES, OPERATION_RULES, OPERATION_SCHEMA_BY_NAME } from "./operations/OperationSchemas";

/** Arguments of {@link DescribeOperationsTool}. */
export class DescribeOperationsArgs {
    static schema = {
        ops: z
            .array(z.string().min(1).max(64))
            .min(1)
            .max(20)
            .describe(
                "Names of the apply_operations ops to describe, such as create_text and set_text_style " +
                    "(1 to 20 names)."
            ),
    };

    ops!: string[];
}

/** Returns the parameters of named `apply_operations` ops as JSON Schema, with the rules that span ops. */
export class DescribeOperationsTool extends BackendTool<DescribeOperationsArgs> {
    constructor(mcpServer: PenpotMcpServer, services: BackendServices) {
        super(mcpServer, DescribeOperationsArgs.schema, services);
    }

    public annotations(): ToolAnnotations {
        return { readOnlyHint: true, destructiveHint: false };
    }

    public getToolName(): string {
        return "describe_operations";
    }

    public getToolDescription(): string {
        return (
            "Returns the parameters of named apply_operations ops as JSON Schema, and the rules that span ops: " +
            "font variants, token types, overrides and child index. Use it when an op is rejected, before " +
            "guessing a parameter name. Each op is a camelCase object with an op field."
        );
    }

    protected async executeBackend(args: DescribeOperationsArgs, _userToken: string): Promise<ToolResponse> {
        const unknown = args.ops.filter((name) => !OPERATION_NAMES.includes(name));
        if (unknown.length > 0) {
            throw new Error(
                `describe_operations: unknown op ${unknown.map((name) => JSON.stringify(name)).join(", ")}. ` +
                    `Valid ops: ${OPERATION_NAMES.join(", ")}.`
            );
        }
        const operations = Object.fromEntries(
            args.ops.map((name) => [name, DescribeOperationsTool.jsonSchemaOf(name)])
        );
        return this.jsonResponse({ operations, rules: OPERATION_RULES });
    }

    /**
     * Converts the parameter schema of one op to JSON Schema.
     *
     * @param name - a valid op name, checked by the caller
     * @returns the JSON Schema of the op, without the `$schema` marker
     */
    private static jsonSchemaOf(name: string): unknown {
        const schema = z.toJSONSchema(OPERATION_SCHEMA_BY_NAME[name], { io: "input" });
        const { $schema: _marker, ...rest } = schema;
        return rest;
    }
}
