import { ExportDirectory } from "../../utils/ExportDirectory";

/**
 * The directory that import tools may read a local file from when a caller passes a `filePath`.
 *
 * The root comes from `PENPOT_MCP_IMPORT_DIR`, and defaults to `penpot-imports` in the home directory. A file is
 * read only when it lies inside the root and passes through no symbolic link below it, the same rule as for exports.
 */
export class ImportDirectory {
    /** Environment variable that sets the import root. */
    public static readonly VARIABLE = "PENPOT_MCP_IMPORT_DIR";

    /** Folder under the home directory that holds the imports when no root is configured. */
    public static readonly DEFAULT_FOLDER = "penpot-imports";

    /**
     * Returns the absolute import root.
     *
     * @param env - the environment to read
     * @throws Error naming the variable when it is set to a path that is not absolute
     */
    public static rootOf(env: Record<string, string | undefined>): string {
        return ExportDirectory.rootFromVariable(env, ImportDirectory.VARIABLE, ImportDirectory.DEFAULT_FOLDER);
    }

    /**
     * Checks that a file to read lies inside the import root, with no link on the way.
     *
     * The check runs before the file is looked at, so that a path outside the root never reveals whether it exists.
     *
     * @param filePath - the absolute path the caller gave
     * @param env - the environment that names the root
     * @throws Error when the path lies outside the import root or passes through a symbolic link
     */
    public static assertReadable(filePath: string, env: Record<string, string | undefined>): void {
        ExportDirectory.assertUnderRoot(filePath, ImportDirectory.rootOf(env), ImportDirectory.VARIABLE, "import");
    }
}
