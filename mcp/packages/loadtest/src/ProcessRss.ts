import { readFile } from "node:fs/promises";
import { type CommandRunner, defaultRunner } from "./PgStats.js";

/** Reads a text file and resolves with its content. Replaceable in tests. */
export type StatusReader = (path: string) => Promise<string>;

/**
 * Reads the resident memory (working set on Windows) of another process, such as the MCP server under test.
 */
export class ProcessRss {
    /**
     * @param pid - process id of the process to watch
     * @param run - command runner used on Windows and on other systems than Linux, replaceable in tests
     * @param platform - operating system family, defaults to the host
     * @param readStatus - reader for /proc files on Linux, replaceable in tests
     */
    constructor(
        private readonly pid: number,
        private readonly run: CommandRunner = defaultRunner,
        private readonly platform: NodeJS.Platform = process.platform,
        private readonly readStatus: StatusReader = (path) => readFile(path, "utf8")
    ) {}

    /**
     * Reads the resident memory of the process once.
     *
     * @returns the resident size in bytes
     * @throws Error when the process is not found or its memory cannot be read
     */
    async read(): Promise<number> {
        if (this.platform === "win32") {
            return this.readWindows();
        }
        if (this.platform === "linux") {
            return this.readLinux();
        }
        return this.readPs();
    }

    /**
     * Reads the working set from the last CSV field of tasklist, for example "123,456 K".
     *
     * @throws Error when tasklist does not list the process
     */
    private async readWindows(): Promise<number> {
        const output = await this.run("tasklist", ["/FI", `PID eq ${this.pid}`, "/FO", "CSV", "/NH"]);
        const line = output
            .split(/\r?\n/)
            .map((text) => text.trim())
            .find((text) => text !== "");
        if (line === undefined || line.startsWith("INFO:") || !line.includes(`"${this.pid}"`)) {
            throw this.notFound();
        }
        const digits = /"([^"]*)"\s*$/.exec(line)?.[1].replace(/\D/g, "") ?? "";
        if (digits === "") {
            throw new Error(`cannot read the memory of process ${this.pid} from tasklist output: "${line}"`);
        }
        return Number(digits) * 1024;
    }

    /**
     * Reads VmRSS, in kB, from /proc/<pid>/status.
     *
     * @throws Error when the process has no status file or no VmRSS line
     */
    private async readLinux(): Promise<number> {
        let status: string;
        try {
            status = await this.readStatus(`/proc/${this.pid}/status`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                throw this.notFound();
            }
            throw error;
        }
        const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        if (match === null) {
            throw new Error(`process ${this.pid} has no VmRSS line in its status file`);
        }
        return Number(match[1]) * 1024;
    }

    /**
     * Reads the resident size, in kB, that ps prints for the process.
     *
     * @throws Error when ps prints nothing for the process
     */
    private async readPs(): Promise<number> {
        const output = (await this.run("ps", ["-o", "rss=", "-p", String(this.pid)])).trim();
        if (output === "") {
            throw this.notFound();
        }
        if (!/^\d+$/.test(output)) {
            throw new Error(`cannot read the memory of process ${this.pid} from ps output: "${output}"`);
        }
        return Number(output) * 1024;
    }

    /**
     * Builds the error for a process that does not exist.
     */
    private notFound(): Error {
        return new Error(`process ${this.pid} not found`);
    }
}
