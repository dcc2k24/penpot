import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root directory, the parent of the folder that holds this module. */
export const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Output folder for generated files, `out/` inside the package root. */
export const OUT_DIR: string = join(PACKAGE_ROOT, "out");

/** Record of the built file: file id, page ids, component ids and batch timings. */
export const IDS_FILE: string = join(OUT_DIR, "ids.json");

/** Normalised model of the built file, written by the pull step. */
export const DESIGN_FILE: string = join(OUT_DIR, "design.json");

/** Generated React app, `app/` inside the package root. Its generated folders are rewritten by `generate`. */
export const APP_DIR: string = join(PACKAGE_ROOT, "app");

/** Output folder of the comparison: DOM and pixel reports, screenshots and diff images. */
export const COMPARE_DIR: string = join(OUT_DIR, "compare");

/** Known limitations of the MCP tools met while building the file. */
export const KNOWN_GAPS_FILE: string = join(PACKAGE_ROOT, "KNOWN_GAPS.md");

/** Streamable HTTP endpoint of the backend-mode MCP server. Override with PENPOT_MCP_URL. */
export const MCP_URL: string = process.env.PENPOT_MCP_URL ?? "http://127.0.0.1:4405/mcp";

/**
 * Reads a setting that has no default. The setting must name a value, so that no machine path is built into the
 * package.
 *
 * @param name - name of the environment variable
 * @returns the trimmed value
 * @throws Error that names the variable when it is missing or empty
 */
export function requiredSetting(name: string): string {
    const value = process.env[name]?.trim();
    if (value === undefined || value === "") {
        throw new Error(`${name} is not set. Set it to the value that the README describes.`);
    }
    return value;
}

/**
 * Path of the file that holds the MCP access token. Read from DESIGN_PARITY_TOKEN_FILE, which is required.
 *
 * @throws Error that names DESIGN_PARITY_TOKEN_FILE when it is not set
 */
export function tokenFilePath(): string {
    return requiredSetting("DESIGN_PARITY_TOKEN_FILE");
}

/**
 * Path of the file that holds the ids of the live stack, with `projectId`. Read from DESIGN_PARITY_VARS_FILE, which
 * is required.
 *
 * @throws Error that names DESIGN_PARITY_VARS_FILE when it is not set
 */
export function varsFilePath(): string {
    return requiredSetting("DESIGN_PARITY_VARS_FILE");
}

/**
 * Folder of the Penpot font files, which the generator copies into the app. Read from PENPOT_FONT_DIR, which is
 * required.
 *
 * @throws Error that names PENPOT_FONT_DIR when it is not set
 */
export function penpotFontDir(): string {
    return requiredSetting("PENPOT_FONT_DIR");
}
