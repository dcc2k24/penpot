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

/**
 * Creates a symbolic link, or skips the calling test when the system does not allow it.
 *
 * @param target - what the link points to
 * @param link - where the link is made
 * @param type - the link type, such as `dir` or `junction` on Windows
 * @returns true when the link was made
 */
function tryLink(target: string, link: string, type: "dir" | "file" | "junction"): boolean {
    try {
        fs.symlinkSync(target, link, type);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES") {
            return false;
        }
        throw error;
    }
}

test("the export root defaults to penpot-exports in the home directory", () => {
    assert.equal(ExportDirectory.rootOf({}), path.join(path.resolve(os.homedir()), "penpot-exports"));
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

test("the root is created on first use when it does not exist", () => {
    const parent = tempDir("export-parent-");
    try {
        const root = path.join(parent.dir, "exports");
        ExportDirectory.assertInside(path.join(root, "out.png"), { PENPOT_MCP_EXPORT_DIR: root });
        assert.equal(fs.statSync(root).isDirectory(), true);
    } finally {
        parent.cleanup();
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

test("a path through a symbolic link below the root is refused, even when the link is dangling", (t) => {
    const root = tempDir("export-root-");
    try {
        const env = { PENPOT_MCP_EXPORT_DIR: root.dir };
        const elsewhere = path.join(root.dir, "elsewhere");
        fs.mkdirSync(elsewhere);
        if (!tryLink(elsewhere, path.join(root.dir, "folder-link"), "junction")) {
            t.skip("this system does not allow links");
            return;
        }
        assert.throws(
            () => ExportDirectory.assertInside(path.join(root.dir, "folder-link", "out.png"), env),
            /must not pass through a symbolic link/
        );
        // a file link that points nowhere; the write would follow it, so it is refused
        const missing = path.join(root.dir, "nowhere", "out.png");
        if (!tryLink(missing, path.join(root.dir, "dangling.png"), "file")) {
            t.skip("this system does not allow file links");
            return;
        }
        assert.throws(
            () => ExportDirectory.assertInside(path.join(root.dir, "dangling.png"), env),
            /must not pass through a symbolic link/
        );
    } finally {
        root.cleanup();
    }
});

test("a file name must end in one of the extensions of its format", () => {
    assert.doesNotThrow(() => ExportDirectory.assertExtension("/x/out.JPG", [".jpg", ".jpeg"]));
    assert.throws(
        () => ExportDirectory.assertExtension("/x/out.png", [".jpg", ".jpeg"]),
        /must end in \.jpg or \.jpeg/
    );
    assert.throws(() => ExportDirectory.assertExtension("/x/out", [".png"]), /got no extension/);
});

test("an existing file is refused by assertAbsent, and a free name is accepted", () => {
    const root = tempDir("export-existing-");
    try {
        const existing = path.join(root.dir, "out.png");
        fs.writeFileSync(existing, "keep");
        assert.throws(() => ExportDirectory.assertAbsent(existing), /already exists\. Pass overwrite true/);
        assert.doesNotThrow(() => ExportDirectory.assertAbsent(path.join(root.dir, "free.png")));
    } finally {
        root.cleanup();
    }
});
