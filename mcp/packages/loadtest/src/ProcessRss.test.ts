import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CommandRunner } from "./PgStats.js";
import { ProcessRss, type StatusReader } from "./ProcessRss.js";

/**
 * Builds a runner that records its calls and answers with fixed output.
 *
 * @param output - standard output to return
 * @param calls - receives every command the runner got
 */
function recordingRunner(output: string, calls: string[][] = []): CommandRunner {
    return async (file, args) => {
        calls.push([file, ...args]);
        return output;
    };
}

/**
 * Builds a status reader that answers with fixed text and records the paths it was asked for.
 *
 * @param text - file content to return
 * @param paths - receives every path that was read
 */
function recordingReader(text: string, paths: string[] = []): StatusReader {
    return async (path) => {
        paths.push(path);
        return text;
    };
}

describe("ProcessRss.read on win32", () => {
    test("parses the working set from the last tasklist CSV field", async () => {
        const calls: string[][] = [];
        const output = '"node.exe","1234","Console","1","123,456 K"\r\n';
        const rss = new ProcessRss(1234, recordingRunner(output, calls), "win32");
        assert.equal(await rss.read(), 123456 * 1024);
        assert.deepEqual(calls, [["tasklist", "/FI", "PID eq 1234", "/FO", "CSV", "/NH"]]);
    });

    test("reports a process that tasklist does not list", async () => {
        const output = "INFO: No tasks are running which match the specified criteria.\r\n";
        const rss = new ProcessRss(4321, recordingRunner(output), "win32");
        await assert.rejects(rss.read(), /process 4321 not found/);
    });
});

describe("ProcessRss.read on linux", () => {
    test("reads VmRSS from the status file in kB", async () => {
        const paths: string[] = [];
        const calls: string[][] = [];
        const status = "Name:\tnode\nVmPeak:\t  9000 kB\nVmRSS:\t   2048 kB\nThreads:\t3\n";
        const rss = new ProcessRss(77, recordingRunner("", calls), "linux", recordingReader(status, paths));
        assert.equal(await rss.read(), 2048 * 1024);
        assert.deepEqual(paths, ["/proc/77/status"]);
        assert.deepEqual(calls, [], "no command runs on linux");
    });

    test("reports a process whose status file is gone", async () => {
        const missing: StatusReader = async () => {
            throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
        };
        const rss = new ProcessRss(77, recordingRunner(""), "linux", missing);
        await assert.rejects(rss.read(), /process 77 not found/);
    });

    test("fails when the status file has no VmRSS line", async () => {
        const rss = new ProcessRss(77, recordingRunner(""), "linux", recordingReader("Name:\tnode\n"));
        await assert.rejects(rss.read(), /no VmRSS line/);
    });
});

describe("ProcessRss.read on other systems", () => {
    test("reads the resident size that ps prints in kB", async () => {
        const calls: string[][] = [];
        const rss = new ProcessRss(88, recordingRunner("  5120\n", calls), "darwin");
        assert.equal(await rss.read(), 5120 * 1024);
        assert.deepEqual(calls, [["ps", "-o", "rss=", "-p", "88"]]);
    });

    test("reports a process that ps does not print", async () => {
        const rss = new ProcessRss(88, recordingRunner("\n"), "darwin");
        await assert.rejects(rss.read(), /process 88 not found/);
    });
});
