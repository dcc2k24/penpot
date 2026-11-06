import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The directory that export tools may write to when a caller passes a `filePath`.
 *
 * The root comes from `PENPOT_MCP_EXPORT_DIR` and defaults to the home directory of the user who runs the
 * server. A path is accepted only when it lies inside the root, after symbolic links are resolved, so that
 * a link inside the root cannot lead the write elsewhere.
 */
export class ExportDirectory {
    /**
     * Returns the absolute root of the export directory.
     *
     * @param env - the environment to read
     * @throws Error naming the variable when it is set to a path that is not absolute
     */
    public static rootOf(env: Record<string, string | undefined>): string {
        const configured = env.PENPOT_MCP_EXPORT_DIR?.trim();
        if (configured === undefined || configured === "") {
            return path.resolve(os.homedir() || process.cwd());
        }
        if (!path.isAbsolute(configured)) {
            throw new Error(`PENPOT_MCP_EXPORT_DIR must be an absolute path (got "${configured}").`);
        }
        return path.resolve(configured);
    }

    /**
     * Checks that a file path lies inside the export root.
     *
     * @param filePath - the absolute path that a tool is about to write
     * @param env - the environment that names the root
     * @throws Error when the path lies outside the export root, naming the root and the variable
     */
    public static assertInside(filePath: string, env: Record<string, string | undefined>): void {
        const root = ExportDirectory.realPathOf(ExportDirectory.rootOf(env));
        const target = ExportDirectory.realPathOf(path.resolve(filePath));
        const relative = path.relative(root, target);
        const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
        if (!inside) {
            throw new Error(
                `The export path must be inside the export directory ${root} (set PENPOT_MCP_EXPORT_DIR to change it).`
            );
        }
    }

    /**
     * Resolves symbolic links in the longest existing prefix of a path and appends the rest unchanged.
     *
     * @param target - an absolute path that may not exist yet
     */
    private static realPathOf(target: string): string {
        let existing = target;
        const missing: string[] = [];
        while (!fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) {
                break;
            }
            missing.unshift(path.basename(existing));
            existing = parent;
        }
        return path.join(fs.realpathSync(existing), ...missing);
    }
}
