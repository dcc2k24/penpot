import * as zlib from "node:zlib";

/** A CRC-32 function over bytes, such as the one that `node:zlib` offers on recent Node versions. */
export type CrcFunction = (data: Uint8Array) => number;

/** One file of a ZIP archive: its name inside the archive and its uncompressed bytes. */
export interface ZipEntry {
    /** Name of the entry, with forward slashes, as the archive stores it. */
    name: string;
    /** Uncompressed bytes of the entry. */
    data: Uint8Array;
}

/** Raised when an archive is over one of the limits the caller or the reader sets: the total size or the entry count. */
export class ZipLimitError extends Error {
    /**
     * Creates the error.
     *
     * @param message - what is over which limit
     */
    constructor(message: string) {
        super(message);
        this.name = "ZipLimitError";
    }
}

/**
 * Reads a ZIP archive held in memory. It supports stored (method 0) and deflated (method 8) entries only.
 *
 * It refuses, with a clear error, what it does not handle: encrypted entries, ZIP64 archives, other methods,
 * sizes that do not match, names that would leave the folder (a leading slash, a drive letter or a `..` part),
 * more than {@link ZipReader.MAX_ENTRIES} entries, and a total uncompressed size above the cap that the caller gives.
 * No new dependency: the inflate uses `node:zlib`.
 */
export class ZipReader {
    /** Most entries an archive may hold. */
    public static readonly MAX_ENTRIES = 1000;

    /** Signature of the end-of-central-directory record. */
    private static readonly EOCD_SIGNATURE = 0x06054b50;
    /** Signature of one central directory file header. */
    private static readonly CENTRAL_SIGNATURE = 0x02014b50;
    /** Signature of one local file header. */
    private static readonly LOCAL_SIGNATURE = 0x04034b50;
    /** Size of the end-of-central-directory record without its comment. */
    private static readonly EOCD_MIN_BYTES = 22;
    /** Largest comment that may follow the end-of-central-directory record. */
    private static readonly MAX_COMMENT_BYTES = 0xffff;
    /** Size of a central directory file header without its name, extra field and comment. */
    private static readonly CENTRAL_HEADER_BYTES = 46;
    /** Size of a local file header without its name and extra field. */
    private static readonly LOCAL_HEADER_BYTES = 30;
    /** Compression method that stores the bytes as they are. */
    private static readonly METHOD_STORED = 0;
    /** Compression method that is raw deflate. */
    private static readonly METHOD_DEFLATED = 8;
    /** General purpose flag bit that marks an encrypted entry. */
    private static readonly FLAG_ENCRYPTED = 0x1;
    /** Value that marks a ZIP64 field in the classic records. */
    private static readonly ZIP64_MARK = 0xffffffff;
    /** Lookup table of CRC-32 (polynomial 0xEDB88320), built once. */
    private static readonly CRC_TABLE: Uint32Array = ZipReader.buildCrcTable();

    /**
     * The native CRC-32 of `node:zlib`, when the running Node has it (`zlib.crc32` arrived in recent versions), else
     * undefined. Set by {@link setNativeCrc} in tests.
     */
    private static nativeCrc: CrcFunction | undefined =
        typeof zlib.crc32 === "function" ? (data: Uint8Array) => zlib.crc32(data) : undefined;

    /**
     * Tells whether the running Node provides the native CRC-32, which the reader uses before its own table.
     */
    public static get nativeCrcAvailable(): boolean {
        return ZipReader.nativeCrc !== undefined;
    }

    /**
     * Replaces the CRC-32 function that the reader uses. Pass undefined to use the table. Tests use this to run both
     * paths; production code keeps the default.
     *
     * @param crc - the native function, or undefined for the table
     */
    public static setNativeCrc(crc: CrcFunction | undefined): void {
        ZipReader.nativeCrc = crc;
    }

    /**
     * Computes the CRC-32 of some bytes, as ZIP stores it: the native function when there is one, else the table.
     *
     * @param bytes - the bytes to check
     * @returns the CRC-32 as an unsigned 32-bit number
     */
    public static crc32(bytes: Uint8Array): number {
        return ZipReader.nativeCrc !== undefined ? ZipReader.nativeCrc(bytes) : ZipReader.crc32Table(bytes);
    }

    /**
     * Computes the CRC-32 of some bytes with the table, which works on every Node version and is the fallback.
     *
     * @param bytes - the bytes to check
     * @returns the CRC-32 as an unsigned 32-bit number
     */
    public static crc32Table(bytes: Uint8Array): number {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc = ZipReader.CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    /**
     * Builds the CRC-32 lookup table.
     *
     * @returns the 256 entries of the table
     */
    private static buildCrcTable(): Uint32Array {
        const table = new Uint32Array(256);
        for (let index = 0; index < 256; index++) {
            let value = index;
            for (let bit = 0; bit < 8; bit++) {
                value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
            }
            table[index] = value >>> 0;
        }
        return table;
    }

    /**
     * Reads every entry of a ZIP archive.
     *
     * @param bytes - the archive
     * @param maxTotalBytes - the largest total of the uncompressed sizes that the archive may declare
     * @returns the entries, in central directory order
     * @throws Error when the bytes are not a ZIP archive, are truncated, use an unsupported feature, name an
     *   unsafe path, or are larger than the cap
     */
    public static read(bytes: Uint8Array, maxTotalBytes: number): ZipEntry[] {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const eocd = ZipReader.findEndRecord(buffer);
        const entryCount = buffer.readUInt16LE(eocd + 10);
        const centralSize = buffer.readUInt32LE(eocd + 12);
        const centralOffset = buffer.readUInt32LE(eocd + 16);
        if (buffer.readUInt16LE(eocd + 8) !== entryCount) {
            throw new Error("The ZIP archive spans several disks, which is not supported.");
        }
        if (entryCount === 0xffff || centralSize === ZipReader.ZIP64_MARK || centralOffset === ZipReader.ZIP64_MARK) {
            throw new Error("The ZIP archive is ZIP64, which is not supported.");
        }
        if (entryCount > ZipReader.MAX_ENTRIES) {
            throw new ZipLimitError(
                `The ZIP archive holds ${entryCount} entries; the limit is ${ZipReader.MAX_ENTRIES}.`
            );
        }
        if (centralOffset + centralSize > eocd) {
            throw new Error("The ZIP archive is truncated: its central directory is missing.");
        }
        const headers = ZipReader.readCentralHeaders(buffer, centralOffset, entryCount);
        const declared = headers.reduce((sum, header) => sum + header.size, 0);
        if (declared > maxTotalBytes) {
            throw new ZipLimitError(
                `The ZIP archive would inflate to ${declared} bytes; the limit is ${maxTotalBytes}.`
            );
        }
        return headers.map((header) => {
            const data = ZipReader.dataOf(buffer, header);
            if (ZipReader.crc32(data) !== header.crc) {
                throw new Error(`The ZIP entry "${header.name}" fails its CRC-32 check: the archive is damaged.`);
            }
            return { name: header.name, data };
        });
    }

    /**
     * Finds the end-of-central-directory record, which sits in the last bytes of the archive.
     *
     * @param buffer - the archive
     * @returns the offset of the record
     * @throws Error when no record is found, which means the bytes are not a ZIP archive or are truncated
     */
    private static findEndRecord(buffer: Buffer): number {
        if (buffer.length < ZipReader.EOCD_MIN_BYTES) {
            throw new Error("The bytes are too short to be a ZIP archive.");
        }
        const earliest = Math.max(0, buffer.length - ZipReader.EOCD_MIN_BYTES - ZipReader.MAX_COMMENT_BYTES);
        for (let offset = buffer.length - ZipReader.EOCD_MIN_BYTES; offset >= earliest; offset--) {
            if (buffer.readUInt32LE(offset) === ZipReader.EOCD_SIGNATURE) {
                return offset;
            }
        }
        throw new Error("The bytes are not a ZIP archive, or the archive is truncated: no end record was found.");
    }

    /**
     * Walks the central directory and reads the header of every entry, checking what the reader supports.
     *
     * @param buffer - the archive
     * @param offset - offset of the first central directory header
     * @param count - number of entries the end record names
     * @returns the header of each entry
     * @throws Error for a bad signature, an unsupported feature, an unsafe name or a truncated directory
     */
    private static readCentralHeaders(buffer: Buffer, offset: number, count: number): EntryHeader[] {
        const headers: EntryHeader[] = [];
        let position = offset;
        for (let index = 0; index < count; index++) {
            ZipReader.assertRoom(buffer, position, ZipReader.CENTRAL_HEADER_BYTES, "central directory");
            if (buffer.readUInt32LE(position) !== ZipReader.CENTRAL_SIGNATURE) {
                throw new Error("The ZIP central directory has a bad signature.");
            }
            const flags = buffer.readUInt16LE(position + 8);
            const method = buffer.readUInt16LE(position + 10);
            const compressedSize = buffer.readUInt32LE(position + 20);
            const size = buffer.readUInt32LE(position + 24);
            const nameLength = buffer.readUInt16LE(position + 28);
            const extraLength = buffer.readUInt16LE(position + 30);
            const commentLength = buffer.readUInt16LE(position + 32);
            const crc = buffer.readUInt32LE(position + 16);
            const localOffset = buffer.readUInt32LE(position + 42);
            ZipReader.assertRoom(buffer, position + ZipReader.CENTRAL_HEADER_BYTES, nameLength, "central directory");
            const name = buffer.toString("utf8", position + 46, position + 46 + nameLength);
            if ((flags & ZipReader.FLAG_ENCRYPTED) !== 0) {
                throw new Error(`The ZIP entry "${name}" is encrypted, which is not supported.`);
            }
            if (method !== ZipReader.METHOD_STORED && method !== ZipReader.METHOD_DEFLATED) {
                throw new Error(`The ZIP entry "${name}" uses compression method ${method}, which is not supported.`);
            }
            if (compressedSize === ZipReader.ZIP64_MARK || size === ZipReader.ZIP64_MARK) {
                throw new Error(`The ZIP entry "${name}" is ZIP64, which is not supported.`);
            }
            ZipReader.assertSafeName(name);
            headers.push({ name, method, compressedSize, size, localOffset, crc });
            position += ZipReader.CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
        }
        return headers;
    }

    /**
     * Returns the uncompressed bytes of one entry, read from its local header and data.
     *
     * @param buffer - the archive
     * @param header - the entry header from the central directory
     * @returns the uncompressed bytes
     * @throws Error when the local header is bad, the data is truncated, or the sizes do not match
     */
    private static dataOf(buffer: Buffer, header: EntryHeader): Uint8Array {
        const local = header.localOffset;
        ZipReader.assertRoom(buffer, local, ZipReader.LOCAL_HEADER_BYTES, "local header");
        if (buffer.readUInt32LE(local) !== ZipReader.LOCAL_SIGNATURE) {
            throw new Error(`The ZIP entry "${header.name}" has a bad local header signature.`);
        }
        const nameLength = buffer.readUInt16LE(local + 26);
        const extraLength = buffer.readUInt16LE(local + 28);
        const start = local + ZipReader.LOCAL_HEADER_BYTES + nameLength + extraLength;
        ZipReader.assertRoom(buffer, start, header.compressedSize, `entry "${header.name}"`);
        const packed = buffer.subarray(start, start + header.compressedSize);
        if (header.method === ZipReader.METHOD_STORED) {
            if (header.compressedSize !== header.size) {
                throw new Error(`The stored ZIP entry "${header.name}" has sizes that do not match.`);
            }
            return new Uint8Array(packed);
        }
        let inflated: Buffer;
        try {
            // the declared size bounds the output, so that a small entry cannot inflate past what it claims
            inflated = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, header.size) });
        } catch {
            throw new Error(`The ZIP entry "${header.name}" cannot be inflated, or inflates past its declared size.`);
        }
        if (inflated.length !== header.size) {
            throw new Error(`The ZIP entry "${header.name}" has a size that does not match its header.`);
        }
        return new Uint8Array(inflated);
    }

    /**
     * Checks that a name stays inside the archive folder: no leading slash, no drive letter and no `..` part.
     *
     * @param name - the entry name as the archive stores it
     * @throws Error when the name is absolute or climbs out of the folder
     */
    private static assertSafeName(name: string): void {
        const parts = name.split(/[\\/]/);
        if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || parts.includes("..")) {
            throw new Error(`The ZIP entry name "${name}" is not a safe relative path.`);
        }
    }

    /**
     * Checks that a range of the archive lies inside it.
     *
     * @param buffer - the archive
     * @param start - first byte of the range
     * @param length - number of bytes in the range
     * @param what - the part of the archive, named in the error
     * @throws Error when the range runs past the end of the archive
     */
    private static assertRoom(buffer: Buffer, start: number, length: number, what: string): void {
        if (start < 0 || start + length > buffer.length) {
            throw new Error(`The ZIP archive is truncated: the ${what} runs past the end.`);
        }
    }
}

/** The facts of one entry that the central directory holds. */
interface EntryHeader {
    /** Name of the entry. */
    name: string;
    /** Compression method: 0 stored, 8 deflated. */
    method: number;
    /** Size of the entry data in the archive. */
    compressedSize: number;
    /** Uncompressed size that the header declares. */
    size: number;
    /** Offset of the local file header of the entry. */
    localOffset: number;
    /** CRC-32 of the uncompressed bytes, as the central directory holds it. */
    crc: number;
}
