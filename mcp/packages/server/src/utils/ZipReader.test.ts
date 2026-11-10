import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { test } from "node:test";
import { ZipReader } from "./ZipReader";

/** Builds the CRC-32 that the archive headers carry for some bytes. */
function crcOf(data: Uint8Array): number {
    return ZipReader.crc32(data);
}

/** One entry that the test ZIP builder writes. */
interface TestEntry {
    /** Name of the entry in the archive. */
    name: string;
    /** Uncompressed bytes of the entry. */
    data: Uint8Array;
    /** Compression method: 0 stores the bytes, 8 deflates them. Defaults to 8. */
    method?: number;
    /** Size that the headers declare, when it is not the real size. */
    declaredSize?: number;
    /** General purpose flags, such as the encryption bit. */
    flags?: number;
    /** Writes the entry as a streaming writer does: bit 3 set, zero sizes in the local header, and a data descriptor. */
    descriptor?: boolean;
}

/**
 * Builds a ZIP archive by hand from local headers, central directory headers and the end record.
 *
 * @param entries - the entries, in archive order
 * @returns the archive bytes
 */
function buildZip(entries: TestEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const method = entry.method ?? 8;
        const name = Buffer.from(entry.name, "utf8");
        const packed = method === 8 ? zlib.deflateRawSync(entry.data) : Buffer.from(entry.data);
        const size = entry.declaredSize ?? entry.data.length;
        const flags = (entry.flags ?? 0) | (entry.descriptor === true ? 0x8 : 0);
        const crc = crcOf(entry.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        if (entry.descriptor !== true) {
            local.writeUInt32LE(crc, 14);
            local.writeUInt32LE(packed.length, 18);
            local.writeUInt32LE(size, 22);
        }
        local.writeUInt16LE(name.length, 26);
        let body = Buffer.concat([local, name, packed]);
        if (entry.descriptor === true) {
            const descriptor = Buffer.alloc(16);
            descriptor.writeUInt32LE(0x08074b50, 0);
            descriptor.writeUInt32LE(crc, 4);
            descriptor.writeUInt32LE(packed.length, 8);
            descriptor.writeUInt32LE(size, 12);
            body = Buffer.concat([body, descriptor]);
        }
        locals.push(body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, name]));
        offset += body.length;
    }
    const centralBytes = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBytes, end]);
}

/** Encodes text as bytes. */
function bytesOf(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** Largest total uncompressed size used in the tests, so that the cap does not get in the way. */
const ROOMY = 1024 * 1024;

test("reads a stored entry and a deflated entry, in archive order", () => {
    const zip = buildZip([
        { name: "a.png", data: bytesOf("stored bytes"), method: 0 },
        { name: "b.png", data: bytesOf("deflated bytes ".repeat(50)), method: 8 },
    ]);
    const entries = ZipReader.read(zip, ROOMY);
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["a.png", "b.png"]
    );
    assert.deepEqual(Buffer.from(entries[0].data), Buffer.from("stored bytes"));
    assert.deepEqual(Buffer.from(entries[1].data), Buffer.from("deflated bytes ".repeat(50)));
});

test("reads a single deflated entry", () => {
    const entries = ZipReader.read(buildZip([{ name: "only.svg", data: bytesOf("<svg/>") }]), ROOMY);
    assert.equal(entries.length, 1);
    assert.equal(Buffer.from(entries[0].data).toString("utf8"), "<svg/>");
});

test("reads an empty archive as no entries", () => {
    assert.deepEqual(ZipReader.read(buildZip([]), ROOMY), []);
});

test("a truncated archive is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("some bytes") }]);
    assert.throws(() => ZipReader.read(zip.subarray(0, zip.length - 30), ROOMY), /truncated|not a ZIP archive/);
    assert.throws(() => ZipReader.read(zip.subarray(0, 10), ROOMY), /too short|not a ZIP archive/);
});

test("a bad end-record signature is refused as not a ZIP archive", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("some bytes") }]);
    zip.writeUInt32LE(0x12345678, zip.length - 22);
    assert.throws(() => ZipReader.read(zip, ROOMY), /not a ZIP archive/);
});

test("a bad central directory signature is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("some bytes") }]);
    const centralStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0x11111111, centralStart);
    assert.throws(() => ZipReader.read(zip, ROOMY), /bad signature/);
});

for (const name of ["../evil.png", "a/../../evil.png", "/abs.png", "\\abs.png", "C:/evil.png"]) {
    test(`an entry named ${JSON.stringify(name)} is refused as an unsafe path`, () => {
        const zip = buildZip([{ name, data: bytesOf("x") }]);
        assert.throws(() => ZipReader.read(zip, ROOMY), /not a safe relative path/);
    });
}

test("a total uncompressed size above the cap is refused before anything is inflated", () => {
    const zip = buildZip([
        { name: "a.png", data: new Uint8Array(600) },
        { name: "b.png", data: new Uint8Array(600) },
    ]);
    assert.throws(() => ZipReader.read(zip, 1000), /would inflate to 1200 bytes; the limit is 1000/);
    assert.equal(ZipReader.read(zip, 1200).length, 2);
});

test("an encrypted entry is refused", () => {
    const zip = buildZip([{ name: "secret.png", data: bytesOf("x"), flags: 0x1 }]);
    assert.throws(() => ZipReader.read(zip, ROOMY), /encrypted/);
});

test("an entry with another compression method is refused", () => {
    const zip = buildZip([{ name: "b.png", data: bytesOf("x"), method: 12 }]);
    assert.throws(() => ZipReader.read(zip, ROOMY), /compression method 12/);
});

test("a stored entry whose sizes do not match is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("abcdef"), method: 0, declaredSize: 4 }]);
    assert.throws(() => ZipReader.read(zip, ROOMY), /sizes that do not match/);
});

test("a deflated entry that inflates past its declared size is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("abcdefghijklmnop"), declaredSize: 4 }]);
    assert.throws(() => ZipReader.read(zip, ROOMY), /cannot be inflated|declared size/);
});

test("an archive with more than 1000 entries is refused", () => {
    const entries: TestEntry[] = Array.from({ length: 1001 }, (_, index) => ({
        name: `f${index}.png`,
        data: new Uint8Array(0),
        method: 0,
    }));
    assert.throws(() => ZipReader.read(buildZip(entries), ROOMY), /holds 1001 entries; the limit is 1000/);
});

test("an archive with ZIP64 markers is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("x") }]);
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 12);
    assert.throws(() => ZipReader.read(zip, ROOMY), /ZIP64/);
});

test("reads entries written with a data descriptor, as streaming writers do: the central directory holds the sizes", () => {
    const stored = bytesOf("stored bytes");
    const deflated = bytesOf("deflated bytes ".repeat(40));
    const zip = buildZip([
        { name: "a.png", data: stored, method: 0, descriptor: true },
        { name: "b.png", data: deflated, method: 8, descriptor: true },
    ]);
    assert.equal(zip.readUInt32LE(18), 0, "the local header carries no size");
    const entries = ZipReader.read(zip, ROOMY);
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["a.png", "b.png"]
    );
    assert.deepEqual(Buffer.from(entries[0].data), Buffer.from(stored));
    assert.deepEqual(Buffer.from(entries[1].data), Buffer.from(deflated));
});

test("the CRC-32 of the check string 123456789 is CBF43926", () => {
    assert.equal(ZipReader.crc32(bytesOf("123456789")), 0xcbf43926);
    assert.equal(ZipReader.crc32(new Uint8Array(0)), 0);
});

test("an entry whose bytes do not match the CRC of the central directory is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("abcdef"), method: 0 }]);
    const start = zip.indexOf(Buffer.from("abcdef"));
    zip[start] = 0x7a;
    assert.throws(() => ZipReader.read(zip, ROOMY), /fails its CRC-32 check/);
});

test("a deflated entry whose CRC is wrong in the central directory is refused", () => {
    const zip = buildZip([{ name: "a.png", data: bytesOf("some bytes to deflate") }]);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0x12345678, central + 16);
    assert.throws(() => ZipReader.read(zip, ROOMY), /fails its CRC-32 check/);
});

test("the native CRC-32 and the table give the same value, and the table gives the check value", () => {
    const data = new Uint8Array(65_536);
    let seed = 7;
    for (let index = 0; index < data.length; index++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[index] = seed & 0xff;
    }
    assert.equal(ZipReader.crc32Table(bytesOf("123456789")), 0xcbf43926);
    assert.equal(ZipReader.crc32Table(data), ZipReader.crc32Table(Buffer.from(data)));
    const original = ZipReader.nativeCrcAvailable ? (bytes: Uint8Array) => zlib.crc32(bytes) : undefined;
    try {
        ZipReader.setNativeCrc(undefined);
        const viaTable = ZipReader.crc32(data);
        if (original !== undefined) {
            ZipReader.setNativeCrc(original);
            assert.equal(ZipReader.crc32(data), viaTable, "native and table agree");
        }
        assert.equal(viaTable, ZipReader.crc32Table(data));
    } finally {
        ZipReader.setNativeCrc(original);
    }
});

test("the reader uses the native CRC-32 when one is set, and the table when none is, and reads the same bytes", () => {
    const original = ZipReader.nativeCrcAvailable ? (bytes: Uint8Array) => zlib.crc32(bytes) : undefined;
    const zip = buildZip([{ name: "a.png", data: bytesOf("the same bytes on both paths") }]);
    let calls = 0;
    try {
        ZipReader.setNativeCrc((bytes) => {
            calls++;
            return ZipReader.crc32Table(bytes);
        });
        assert.equal(ZipReader.read(zip, ROOMY)[0].data.length, "the same bytes on both paths".length);
        assert.ok(calls >= 1, "the injected native function was used");
        ZipReader.setNativeCrc(undefined);
        assert.equal(Buffer.from(ZipReader.read(zip, ROOMY)[0].data).toString("utf8"), "the same bytes on both paths");
    } finally {
        ZipReader.setNativeCrc(original);
    }
});
