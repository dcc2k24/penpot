import { readFile } from "node:fs/promises";
import type { DesignModel } from "../DesignModel.js";
import { APP_DIR, DESIGN_FILE } from "../Paths.js";
import { ReactGenerator } from "./ReactGenerator.js";

/**
 * Generates the React app from the pulled design file into the app folder, and prints a summary and the warnings.
 *
 * @returns 0 on success, or 1 when the design file is missing or invalid, or the generation fails
 */
export async function runGenerate(): Promise<number> {
    let text: string;
    try {
        text = await readFile(DESIGN_FILE, "utf8");
    } catch (error) {
        console.error(`cannot read ${DESIGN_FILE}: ${messageOf(error)}`);
        return 1;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        console.error(`${DESIGN_FILE} is not valid JSON: ${messageOf(error)}`);
        return 1;
    }
    if (!isDesignModel(parsed)) {
        console.error(`${DESIGN_FILE} is not a design model with formatVersion 1`);
        return 1;
    }
    try {
        const summary = new ReactGenerator(parsed, APP_DIR).generate();
        console.log(`generated ${summary.components} components and ${summary.screens} screens into ${APP_DIR}`);
        console.log(`wrote ${summary.files.length} files:`);
        for (const file of summary.files) {
            console.log(`  ${file}`);
        }
        for (const warning of summary.warnings) {
            console.log(warning);
        }
        return 0;
    } catch (error) {
        console.error(`generate failed: ${messageOf(error)}`);
        return 1;
    }
}

/**
 * Tells whether a parsed value has the shape of a version 1 design model, as far as the generator reads it.
 *
 * @param value - parsed JSON value
 */
function isDesignModel(value: unknown): value is DesignModel {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as Partial<Record<keyof DesignModel, unknown>>;
    return (
        candidate.formatVersion === 1 &&
        Array.isArray(candidate.pages) &&
        Array.isArray(candidate.components) &&
        Array.isArray(candidate.typographies) &&
        typeof candidate.tokens === "object" &&
        candidate.tokens !== null
    );
}

/**
 * Returns the message of an unknown error.
 *
 * @param error - caught value
 */
function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
