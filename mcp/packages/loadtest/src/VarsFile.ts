import { readFile, writeFile } from "node:fs/promises";

/**
 * Reads and writes the vars file that names the team, project and files a scenario runs against.
 */
export class VarsFile {
    /**
     * Reads a JSON object of variables.
     *
     * @param file - path of the vars file
     * @throws Error when the file is missing, not JSON, or not an object
     */
    static async read(file: string): Promise<Record<string, unknown>> {
        let json: unknown;
        try {
            json = JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
            throw new Error(`cannot read vars file ${file}: ${(error as Error).message}`);
        }
        if (json === null || typeof json !== "object" || Array.isArray(json)) {
            throw new Error(`vars file ${file} must hold a JSON object`);
        }
        return json as Record<string, unknown>;
    }

    /**
     * Writes variables as pretty-printed JSON.
     *
     * @param file - path to write
     * @param vars - variables to write
     */
    static async write(file: string, vars: Record<string, unknown>): Promise<void> {
        await writeFile(file, JSON.stringify(vars, null, 2) + "\n", "utf8");
    }
}
