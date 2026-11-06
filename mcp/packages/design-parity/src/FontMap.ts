/**
 * Maps the font family names of the design to CSS font stacks. The generator and the comparator both read this table,
 * so that a family name has one CSS value everywhere.
 */

/**
 * Table from the font family name of the design to its CSS font-family value. The value is the internal family name of
 * the Penpot built-in font, quoted, as Penpot writes it on a text.
 */
export const FONT_FAMILY_CSS: Readonly<Record<string, string>> = {
    "Source Sans Pro": '"sourcesanspro"',
};

/** One font file of the font table: the face that a weight and style of a family select. */
export interface FontFile {
    /** Internal font family name, used in the @font-face rule, for example "sourcesanspro". */
    readonly family: string;
    /** CSS font weight of the face. */
    readonly weight: number;
    /** CSS font style of the face. */
    readonly style: "normal" | "italic";
    /** File name of the face in the Penpot font folder, which the generator copies into the app. */
    readonly file: string;
}

/** Font files that the generated app serves. Each row becomes one @font-face rule, in table order. */
export const FONT_FILES: readonly FontFile[] = [
    { family: "sourcesanspro", weight: 400, style: "normal", file: "sourcesanspro-regular.woff" },
    { family: "sourcesanspro", weight: 400, style: "italic", file: "sourcesanspro-italic.woff" },
    { family: "sourcesanspro", weight: 600, style: "normal", file: "sourcesanspro-semibold.woff" },
    { family: "sourcesanspro", weight: 600, style: "italic", file: "sourcesanspro-semibolditalic.woff" },
    { family: "sourcesanspro", weight: 700, style: "normal", file: "sourcesanspro-bold.woff" },
    { family: "sourcesanspro", weight: 700, style: "italic", file: "sourcesanspro-bolditalic.woff" },
];

/**
 * Returns the font files of one internal font family, in table order.
 *
 * @param family - internal font family name of the table, for example "sourcesanspro"
 * @throws Error when the font table has no file for the family
 */
export function fontFilesOf(family: string): FontFile[] {
    const files = FONT_FILES.filter((font) => font.family === family);
    if (files.length === 0) {
        throw new Error(`no font files for family ${family}: add its rows to FONT_FILES in src/FontMap.ts`);
    }
    return files;
}

/**
 * Returns the CSS font-family value of a design font family.
 *
 * @param family - font family name of the design, for example "Source Sans Pro"
 * @throws Error when the family is not in the table
 */
export function cssFontFamily(family: string): string {
    const css = FONT_FAMILY_CSS[family];
    if (css === undefined) {
        throw new Error(`unknown font family ${family}: add it to FONT_FAMILY_CSS in src/FontMap.ts`);
    }
    return css;
}

/**
 * Returns the design font family name of the first family of a CSS font-family value, without quotes. A first family
 * that is the CSS value of a design family gives that design name, so that a measured value compares with the design.
 * Any other first family is returned as it is.
 *
 * @param css - CSS font-family value, for example "\"sourcesanspro\"" or "'Source Sans Pro', sans-serif"
 */
export function primaryFamilyOf(css: string): string {
    const first = bareFirstFamily(css);
    const designFamily = Object.keys(FONT_FAMILY_CSS).find((family) => {
        const value = FONT_FAMILY_CSS[family];
        return value !== undefined && bareFirstFamily(value) === first;
    });
    return designFamily ?? first;
}

/**
 * Returns the first family name of a CSS font-family value, without quotes.
 *
 * @param css - CSS font-family value
 */
function bareFirstFamily(css: string): string {
    const first = css.split(",")[0] ?? "";
    return first.trim().replace(/^['"]|['"]$/g, "");
}
