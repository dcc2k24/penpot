/**
 * One-off integration test for the parallelism bound around image exports.
 *
 * Setup:
 *  - Sets PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS to N before the server modules load, because
 *    ExportConcurrency reads that limit once, when its class is first evaluated.
 *  - Stubs ExportShapeTool.exportImage to sleep SLEEP_MS instead of doing real work,
 *    so no actual plugin connection is needed. The stub runs inside the ExportConcurrency gate.
 *  - Starts a PenpotMcpServer in multi-user mode on three random free ports.
 *  - Fires M > N parallel MCP clients that each call the export_shape tool.
 *
 * Expectations (observed manually from the server's console output):
 *  - "Semaphore 'ExportShapeTool' saturated; request queued (k waiting)" lines appear
 *    at INFO level (at least M - N of them).
 *  - All M tool calls return successfully.
 *  - Total elapsed wall-clock time is approximately ceil(M / N) * SLEEP_MS.
 *
 * Invoke from packages/server with:
 *   pnpm run test:integration:export-sema
 *
 * Pass --help to print the usage and exit without starting a server.
 */
import * as net from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// === parameters ===

const N = 3;
const M = 6;
const SLEEP_MS = 5_000;

// === helpers ===

/** Prints the usage of this script to standard output. */
function printUsage(): void {
    console.log(
        [
            "Usage: tsx scripts/integration-test-export-image-semaphore.ts [--help]",
            "",
            "Starts a multi-user MCP server with a stubbed export and fires M parallel export_shape calls",
            `through an export gate of N=${N} permits (M=${M}, sleep=${SLEEP_MS} ms).`,
            "Run from packages/server. Options:",
            "  -h, --help  print this usage and exit without starting a server",
        ].join("\n")
    );
}

/** Returns true when the command line asks for the usage text. */
function wantsHelp(argv: readonly string[]): boolean {
    return argv.includes("--help") || argv.includes("-h");
}

async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

async function callExportShape(url: URL, idx: number): Promise<unknown> {
    const client = new Client({ name: `integration-test-client-${idx}`, version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    try {
        return await client.callTool({
            name: "export_shape",
            arguments: { shapeId: "selection" },
        });
    } finally {
        await client.close();
    }
}

// === main ===

async function main(): Promise<void> {
    if (wantsHelp(process.argv.slice(2))) {
        printUsage();
        process.exit(0);
    }

    // environment must be set before the server modules are loaded, since their configuration
    // and the export gate are read when their modules are first evaluated
    const httpPort = await findFreePort();
    process.env.PENPOT_MCP_SERVER_HOST = "127.0.0.1";
    process.env.PENPOT_MCP_SERVER_PORT = String(httpPort);
    process.env.PENPOT_MCP_WEBSOCKET_PORT = String(await findFreePort());
    process.env.PENPOT_MCP_REPL_PORT = String(await findFreePort());
    process.env.PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS = String(N);

    const { PenpotMcpServer } = await import("../src/PenpotMcpServer");
    const { ExportShapeTool } = await import("../src/tools/ExportShapeTool");
    const { TextResponse } = await import("../src/ToolResponse");

    // stub the worker; the gate in ExportShapeTool.executeCore wraps this call
    const exporter = ExportShapeTool.prototype as unknown as { exportImage: () => Promise<unknown> };
    exporter.exportImage = async (): Promise<unknown> => {
        await new Promise((r) => setTimeout(r, SLEEP_MS));
        return new TextResponse("stubbed export");
    };

    const server = new PenpotMcpServer(/* isMultiUser */ true);
    await server.start();

    console.log(`\n=== integration test: N=${N} permits, M=${M} clients, sleep=${SLEEP_MS}ms ===\n`);

    // fire M parallel tool calls, each via its own MCP session with a distinct userToken
    const start = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: M }, (_, i) =>
            callExportShape(new URL(`http://127.0.0.1:${httpPort}/mcp?userToken=test-token-${i}`), i)
        )
    );
    const elapsed = Date.now() - start;

    await server.stop();

    // report
    const failures = results.map((r, i) => ({ r, i })).filter(({ r }) => r.status === "rejected");

    console.log(`\n=== results ===`);
    console.log(`  elapsed: ${elapsed}ms (expected ~${Math.ceil(M / N) * SLEEP_MS}ms)`);
    console.log(`  succeeded: ${M - failures.length}/${M}`);
    if (failures.length > 0) {
        console.log(`  failures:`);
        for (const { r, i } of failures) {
            console.log(`    [${i}] ${(r as PromiseRejectedResult).reason}`);
        }
        process.exit(1);
    }
    console.log(`\nAll ${M} tool calls succeeded. Scroll up to verify saturation log lines.\n`);
    process.exit(0);
}

main().catch((err) => {
    console.error("Integration test crashed:", err);
    process.exit(1);
});
