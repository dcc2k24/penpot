import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ExportDirectory } from "./ExportDirectory";

/**
 * Creates a fresh temporary directory and returns its path with a cleanup function.
 *
 * @param prefix - name prefix of the directory
 */
function tempDir(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the export root defaults to the home directory", () => {
    assert.equal(ExportDirectory.rootOf({}), path.resolve(os.homedir()));
});

test("PENPOT_MCP_EXPORT_DIR sets the export root, which must be absolute", () => {
    const { dir, cleanup } = tempDir("export-root-");
    try {
        assert.equal(ExportDirectory.rootOf({ PENPOT_MCP_EXPORT_DIR: dir }), path.resolve(dir));
    } finally {
        cleanup();
    }
    assert.throws(() => ExportDirectory.rootOf({ PENPOT_MCP_EXPORT_DIR: "relative/dir" }), /PENPOT_MCP_EXPORT_DIR/);
});

test("a path inside the export root is accepted, including one whose folders do not exist yet", () => {
    const root = tempDir("export-root-");
    try {
        const env = { PENPOT_MCP_EXPORT_DIR: root.dir };
        ExportDirectory.assertInside(path.join(root.dir, "new", "folder", "out.png"), env);
    } finally {
        root.cleanup();
    }
});

test("a path outside the export root, a traversal out of it and the root itself are refused", () => {
    const root = tempDir("export-root-");
    const outside = tempDir("export-outside-");
    try {
        const env = { PENPOT_MCP_EXPORT_DIR: root.dir };
        assert.throws(
            () => ExportDirectory.assertInside(path.join(outside.dir, "out.png"), env),
            /inside the export directory/
        );
        assert.throws(
            () => ExportDirectory.assertInside(path.join(root.dir, "..", path.basename(outside.dir), "x.png"), env),
            /inside the export directory/
        );
        assert.throws(() => ExportDirectory.assertInside(root.dir, env), /inside the export directory/);
    } finally {
        root.cleanup();
        outside.cleanup();
    }
});
