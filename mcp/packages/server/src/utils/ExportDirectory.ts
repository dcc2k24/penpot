import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The directory that export tools may write to when a caller passes a `filePath`.
 *
 * The root comes from `PENPOT_MCP_EXPORT_DIR`. Without it the root is `penpot-exports` in the home directory of the
 * user who runs the server, created on first use. A path is accepted only when it lies inside the root and passes
 * through no symbolic link below the root, so that a link cannot lead the write elsewhere.
 */
export class ExportDirectory {
    /** Folder under the home directory that holds the exports when no root is configured. */
    public static readonly DEFAULT_FOLDER = "penpot-exports";

    /**
     * Returns the absolute root of the export directory.
     *
     * @param env - the environment to read
     * @throws Error naming the variable when it is set to a path that is not absolute
     */
    public static rootOf(env: Record<string, string | undefined>): string {
        return ExportDirectory.rootFromVariable(env, "PENPOT_MCP_EXPORT_DIR", ExportDirectory.DEFAULT_FOLDER);
    }

    /**
     * Returns the absolute root that a variable names, or the folder in the home directory when it is unset.
     *
     * @param env - the environment to read
     * @param variable - the name of the variable, which must be absolute when set
     * @param folder - the folder in the home directory used when the variable is unset
     * @throws Error naming the variable when it is set to a path that is not absolute
     */
    public static rootFromVariable(env: Record<string, string | undefined>, variable: string, folder: string): string {
        const configured = env[variable]?.trim();
        if (configured === undefined || configured === "") {
            return path.resolve(path.join(os.homedir() || process.cwd(), folder));
        }
        if (!path.isAbsolute(configured)) {
            throw new Error(`${variable} must be an absolute path (got "${configured}").`);
        }
        return path.resolve(configured);
    }

    /**
     * Checks that a file path lies inside the export root and passes through no symbolic link below the root.
     *
     * The root is created when it does not exist yet. A link is refused even when it is dangling, since a write
     * through it would create the file where the link points.
     *
     * @param filePath - the absolute path that a tool is about to write
     * @param env - the environment that names the root
     * @throws Error when the path lies outside the export root or passes through a symbolic link
     */
    public static assertInside(filePath: string, env: Record<string, string | undefined>): void {
        const root = ExportDirectory.rootOf(env);
        fs.mkdirSync(root, { recursive: true });
        ExportDirectory.assertUnderRoot(filePath, root, "PENPOT_MCP_EXPORT_DIR");
    }

    /**
     * Checks that a path lies below a root and passes through no symbolic link below it.
     *
     * Used for writes and for reads: the root is not created here.
     *
     * @param filePath - the absolute path to check
     * @param root - the absolute root the path must lie below
     * @param variable - the environment variable that sets the root, named in the error text
     * @param kind - the word for the directory in the error text, such as export or import
     * @throws Error when the path lies outside the root or passes through a symbolic link below it
     */
    public static assertUnderRoot(filePath: string, root: string, variable: string, kind: string = "export"): void {
        const relative = path.relative(root, path.resolve(filePath));
        const inside = relative !== "" && relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
        if (!inside) {
            throw new Error(
                `The ${kind} path must be inside the ${kind} directory ${root} (set ${variable} to change it).`
            );
        }
        ExportDirectory.assertNoLinks(root, relative);
    }

    /**
     * Checks that a file name ends in one of the extensions of its format.
     *
     * @param filePath - the path that a tool is about to write
     * @param extensions - the extensions the format accepts, lower case with the dot, such as `.png`
     * @throws Error when the extension is not one of them
     */
    public static assertExtension(filePath: string, extensions: readonly string[]): void {
        const extension = path.extname(filePath).toLowerCase();
        if (!extensions.includes(extension)) {
            const shown = extension === "" ? "no extension" : `"${extension}"`;
            throw new Error(`The file name must end in ${extensions.join(" or ")} for this format (got ${shown}).`);
        }
    }

    /**
     * Checks that nothing exists at a path yet, so that a write does not replace a file by accident.
     *
     * @param filePath - the path that a tool is about to write
     * @throws Error when a file or a link is already there
     */
    public static assertAbsent(filePath: string): void {
        if (ExportDirectory.exists(filePath)) {
            throw new Error(`${filePath} already exists. Pass overwrite true to replace it, or choose another name.`);
        }
    }

    /**
     * Walks the folders and the file name below the root, one part at a time, and refuses a symbolic link.
     *
     * @param root - the absolute export root, which may be a link itself
     * @param relative - the path below the root
     * @throws Error when a part below the root is a symbolic link
     */
    private static assertNoLinks(root: string, relative: string): void {
        let current = root;
        for (const part of relative.split(path.sep)) {
            current = path.join(current, part);
            let stat: fs.Stats;
            try {
                stat = fs.lstatSync(current);
            } catch (error) {
                if (ExportDirectory.isMissing(error)) {
                    return;
                }
                throw error;
            }
            if (stat.isSymbolicLink()) {
                throw new Error(`The export path must not pass through a symbolic link (${current}).`);
            }
        }
    }

    /**
     * Tells whether a path exists, without following a symbolic link at its end.
     *
     * @param filePath - the path to look up
     */
    private static exists(filePath: string): boolean {
        try {
            fs.lstatSync(filePath);
            return true;
        } catch (error) {
            return !ExportDirectory.isMissing(error);
        }
    }

    /**
     * Tells whether a file system error means that a path, or a part of it, does not exist.
     *
     * @param error - the error that a file system call threw
     */
    private static isMissing(error: unknown): boolean {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === "ENOENT" || code === "ENOTDIR";
    }
}
