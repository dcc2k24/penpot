/** What a tool needs from the server to tell whether it may use local file paths. */
interface FileSystemAccessSource {
    /** True when the server may read and write files on the machine, which is not the case in multi-user mode. */
    isFileSystemAccessEnabled(): boolean;
}

/**
 * Refuses a `filePath` argument when the server is in multi-user mode.
 *
 * The argument stays in the published schema, so that a call that passes it is seen and refused, rather than having
 * the key stripped and the call answered as if the argument had never been given.
 */
export class FilePathAccess {
    /** The refusal, which names the mode and says what to do instead. */
    public static readonly REFUSAL =
        "File paths are off in multi-user mode: this server does not read or write files on the machine. " +
        "Leave filePath out and send the content another way.";

    /**
     * Throws when the server does not allow local file paths.
     *
     * @param server - the server the tool belongs to
     * @throws Error with {@link REFUSAL} when file system access is off
     */
    public static assertAllowed(server: FileSystemAccessSource): void {
        if (!server.isFileSystemAccessEnabled()) {
            throw new Error(FilePathAccess.REFUSAL);
        }
    }
}
