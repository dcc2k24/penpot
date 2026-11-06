/**
 * A colour as the design and the browser both state it: an upper case `#RRGGBB` and an alpha between 0 and 1.
 */
export interface Colour {
    /** Colour as upper case `#RRGGBB`. */
    readonly hex: string;
    /** Alpha between 0 and 1, rounded to three decimals. */
    readonly alpha: number;
}

/** Alpha values closer than this to each other count as equal. */
export const ALPHA_TOLERANCE = 0.001;

/**
 * Normalises a `#RGB`, `#RRGGBB` or `#RRGGBBAA` colour. The result is upper case `#RRGGBB` with its alpha.
 *
 * @param value - colour text from the design or from the browser
 * @throws Error when the text is not a hex colour
 */
export function normaliseHex(value: string): Colour {
    const text = value.trim();
    const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text);
    if (match === null) {
        throw new Error(`not a hex colour: ${value}`);
    }
    let digits = match[1] ?? "";
    if (digits.length === 3) {
        digits = digits
            .split("")
            .map((char) => char + char)
            .join("");
    }
    const hex = `#${digits.slice(0, 6).toUpperCase()}`;
    const alpha = digits.length === 8 ? round3(parseInt(digits.slice(6, 8), 16) / 255) : 1;
    return { hex, alpha };
}

/**
 * Parses a CSS colour as getComputedStyle returns it: `rgb(r, g, b)`, `rgba(r, g, b, a)`, a hex colour, or
 * `transparent`.
 *
 * @param value - computed colour text
 * @throws Error when the text is not a colour this function knows
 */
export function parseCssColour(value: string): Colour {
    const text = value.trim();
    if (text === "transparent") {
        return { hex: "#000000", alpha: 0 };
    }
    if (text.startsWith("#")) {
        return normaliseHex(text);
    }
    const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
    if (match === null) {
        throw new Error(`not a CSS colour: ${value}`);
    }
    const channels = [match[1], match[2], match[3]].map((part) => clampChannel(Number(part)));
    const alpha = match[4] === undefined ? 1 : round3(Math.min(1, Math.max(0, Number(match[4]))));
    const hex = `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    return { hex, alpha };
}

/**
 * Tells whether two colours are the same: equal upper case hex and alpha within the tolerance.
 *
 * @param a - first colour
 * @param b - second colour
 */
export function sameColour(a: Colour, b: Colour): boolean {
    return a.hex === b.hex && Math.abs(a.alpha - b.alpha) < ALPHA_TOLERANCE;
}

/**
 * Formats a colour as a CSS `rgba()` value, the form that the generator writes into the app.
 *
 * @param colour - colour to format
 */
export function toCssRgba(colour: Colour): string {
    const red = parseInt(colour.hex.slice(1, 3), 16);
    const green = parseInt(colour.hex.slice(3, 5), 16);
    const blue = parseInt(colour.hex.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${round3(colour.alpha)})`;
}

/**
 * Rounds a number to three decimals.
 *
 * @param value - number to round
 */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

/**
 * Clamps a colour channel to the range 0 to 255 and rounds it.
 *
 * @param value - channel value
 */
function clampChannel(value: number): number {
    return Math.min(255, Math.max(0, Math.round(value)));
}
