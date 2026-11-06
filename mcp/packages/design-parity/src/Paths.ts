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

/** File that holds the MCP access token. Override with DESIGN_PARITY_TOKEN_FILE. */
export const TOKEN_FILE: string =
    process.env.DESIGN_PARITY_TOKEN_FILE ??
    "C:/Users/colli/AppData/Local/Temp/claude/C--dev-penpot/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/mcp-token.txt";

/** File that holds the ids of the live stack, with `projectId`. Override with DESIGN_PARITY_VARS_FILE. */
export const VARS_FILE: string =
    process.env.DESIGN_PARITY_VARS_FILE ??
    "C:/Users/colli/AppData/Local/Temp/claude/C--dev-penpot/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/vars.json";

/** Streamable HTTP endpoint of the backend-mode MCP server. Override with PENPOT_MCP_URL. */
export const MCP_URL: string = process.env.PENPOT_MCP_URL ?? "http://127.0.0.1:4405/mcp";

/** Folder of the Penpot font files, which the generator copies into the app. Override with PENPOT_FONT_DIR. */
export const PENPOT_FONT_DIR: string = process.env.PENPOT_FONT_DIR ?? "C:/dev/penpot/frontend/resources/fonts";
