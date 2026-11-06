import * as fs from "fs";
import * as path from "path";

/**
 * One font family of the static font list, as the sandbox exposes it through `penpot.fonts`.
 */
export interface FontCatalogEntry {
    /** Family name, for example `Roboto`. */
    family: string;
    /** Font id, for example `gfont-roboto`. */
    id: string;
    /** Variant keys, for example `regular`, `italic` and `700`. */
    variants: string[];
}

/**
 * Reads the static font list from the data directory of the server.
 *
 * The file is read from the current working directory, the same way `ApiDocs` reads `data/api_types.yml`.
 *
 * @returns the font families in the order of the file
 */
function loadFontCatalog(): FontCatalogEntry[] {
    const jsonPath = path.join(process.cwd(), "data", "fonts.json");
    const parsed: unknown = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!Array.isArray(parsed)) {
        throw new Error(`data/fonts.json must hold an array of font families: ${jsonPath}`);
    }
    return parsed as FontCatalogEntry[];
}

/**
 * The static font list, a subset of the built-in font catalogue of Penpot.
 */
export const FONT_CATALOG: FontCatalogEntry[] = loadFontCatalog();
