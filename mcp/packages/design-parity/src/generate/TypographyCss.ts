import type { TypographyModel } from "../DesignModel.js";
import { cssFontFamily, FONT_FILES } from "../FontMap.js";
import { toSlug } from "../Targets.js";
import { GENERATED_CSS_HEADER } from "./TokenCss.js";

/**
 * Renders the @font-face rules of the font table, then one `.typo-<slug>` class per text style, in model order. A
 * declaration is left out when its value is null.
 *
 * @param typographies - text styles of the design library
 * @throws Error when a font family is not in the font table
 */
export function renderTypographyCss(typographies: TypographyModel[]): string {
    const lines = [GENERATED_CSS_HEADER, ...fontFaceRules()];
    for (const typography of typographies) {
        lines.push(`.typo-${toSlug(typography.name)} {`);
        for (const declaration of declarationsOf(typography)) {
            lines.push(`    ${declaration}`);
        }
        lines.push("}");
    }
    lines.push("");
    return lines.join("\n");
}

/**
 * Lists one @font-face rule per row of the font table, in table order. The rules follow the @font-face template of
 * Penpot. The files are served from the public folder.
 */
function fontFaceRules(): string[] {
    const lines: string[] = [];
    for (const font of FONT_FILES) {
        lines.push(
            "@font-face {",
            `    font-family: '${font.family}';`,
            `    font-style: ${font.style};`,
            `    font-weight: ${font.weight};`,
            "    font-display: block;",
            `    src: url("/fonts/${font.file}") format('woff');`,
            "}"
        );
    }
    return lines;
}

/**
 * Lists the CSS declarations of one text style that have a value.
 *
 * @param typography - text style
 */
function declarationsOf(typography: TypographyModel): string[] {
    const declarations: string[] = [];
    if (typography.fontFamily !== null) {
        declarations.push(`font-family: ${cssFontFamily(typography.fontFamily)};`);
    }
    if (typography.fontSize !== null) {
        declarations.push(`font-size: ${typography.fontSize}px;`);
    }
    if (typography.fontWeight !== null) {
        declarations.push(`font-weight: ${typography.fontWeight};`);
    }
    if (typography.lineHeight !== null) {
        declarations.push(`line-height: ${typography.lineHeight};`);
    }
    if (typography.letterSpacing !== null) {
        declarations.push(`letter-spacing: ${typography.letterSpacing}px;`);
    }
    if (typography.textTransform !== null) {
        declarations.push(`text-transform: ${typography.textTransform};`);
    }
    return declarations;
}
