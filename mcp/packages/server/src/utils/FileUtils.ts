import * as path from "path";
import * as fs from "fs";
import { randomBytes } from "crypto";

export class FileUtils {
    /**
     * Checks whether the given file path is absolute and raises an error if not.
     *
     * @param filePath - The file path to check
     */
    public static checkPathIsAbsolute(filePath: string): void {
        if (!path.isAbsolute(filePath)) {
            throw new Error(`The specified file path must be absolute: ${filePath}`);
        }
    }

    public static createParentDirectories(filePath: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Writes binary data to a file at the specified path, creating the parent directories if necessary.
     *
     * @param filePath - The absolute path to the file where data should be written
     * @param bytes - The binary data to write to the file
     * @param options - whether an existing file may be replaced; replaced by default
     */
    public static writeBinaryFile(filePath: string, bytes: Uint8Array, options: FileWriteOptions = {}): void {
        this.createParentDirectories(filePath);
        fs.writeFileSync(filePath, Buffer.from(bytes), { flag: FileUtils.flagOf(options) });
    }

    /**
     * Writes bytes so that an existing file is replaced, not written through: the bytes go to a temporary name in the
     * same folder, which is then renamed onto the target. A hard link or a file that another program has open at the
     * target name keeps its old content. The temporary file is removed when the write fails.
     *
     * With `overwrite` false the write fails, as {@link writeBinaryFile} does, when a file exists.
     *
     * @param filePath - The absolute path to the file where data should be written
     * @param bytes - The binary data to write to the file
     * @param options - whether an existing file may be replaced; replaced by default
     * @throws Error when the write or the rename fails; the temporary file is removed then
     */
    public static writeBinaryFileReplacing(filePath: string, bytes: Uint8Array, options: FileWriteOptions = {}): void {
        if (options.overwrite === false) {
            FileUtils.writeBinaryFile(filePath, bytes, options);
            return;
        }
        this.createParentDirectories(filePath);
        const temporary = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`
        );
        try {
            fs.writeFileSync(temporary, Buffer.from(bytes), { flag: "wx" });
            fs.renameSync(temporary, filePath);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }

    /**
     * Writes text data to a file at the specified path, creating the parent directories if necessary.
     *
     * @param filePath - The absolute path to the file where data should be written
     * @param text - The text data to write to the file
     * @param options - whether an existing file may be replaced; replaced by default
     */
    public static writeTextFile(filePath: string, text: string, options: FileWriteOptions = {}): void {
        this.createParentDirectories(filePath);
        fs.writeFileSync(filePath, text, { encoding: "utf-8", flag: FileUtils.flagOf(options) });
    }

    /**
     * Returns the open flag of a write: `w` replaces a file, `wx` fails when one exists.
     *
     * @param options - the write options
     */
    private static flagOf(options: FileWriteOptions): "w" | "wx" {
        return options.overwrite === false ? "wx" : "w";
    }
}

/** How a file write treats a file that already exists. */
export interface FileWriteOptions {
    /** False refuses to replace an existing file, with the exclusive open flag. Defaults to true. */
    overwrite?: boolean;
}
