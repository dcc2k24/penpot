/**
 * Verifies a pulled model against the design spec. Every check adds one row, so the report reads as a table.
 *
 * The spec walk mirrors the planner. A child of a flex board is placed by the layout, so only its size, type and
 * content are compared. A child of a frame-coordinate board is placed relative to the screen origin.
 */

import {
    layoutComponentPage,
    nodeName,
    normalizeName,
    screenBoard,
    type BoardNode,
    type ComponentSpec,
    type DesignSpec,
    type EllipseNode,
    type FlexSpec,
    type InstanceNode,
    type NodeSpec,
    type RectNode,
    type ScreenSpec,
    type StrokeSpec,
    type TextNode,
    type TypographyName,
} from "./DesignSpec.js";
import type { DesignModel, NodeModel, PageModel } from "./DesignModel.js";
import { backendTokenType } from "./TokenTypes.js";

/**
 * One row of the verification report.
 */
export interface CheckResult {
    /** Readable name of the check, for example "component Button/Primary/MD size". */
    readonly check: string;
    /** Value the spec asks for, as text. */
    readonly expected: string;
    /** Value the model holds, as text. "missing" when the model has no value. */
    readonly actual: string;
    /** True when the actual value meets the expected value. */
    readonly ok: boolean;
}

/**
 * Result of one verifier run.
 */
export interface VerifyReport {
    /** Every check, in the order the checks ran. */
    readonly results: CheckResult[];
    /** Number of checks that passed. */
    readonly passed: number;
    /** Number of checks that failed. */
    readonly failed: number;
    /** Notes on what the backend does not return, so the verifier does not check it. */
    readonly skipped: string[];
}

/** Notes on what the verifier does not check. Always part of every report. */
const SKIPPED_NOTES: readonly string[] = [
    "text typography link (typographyRefId) is not in the model: the link to the library style is not checked",
    "textLayoutState is approximate by design: text box heights and widths come from the spec and are checked, the rendered text size is not",
    "flex child sizing (layoutItem) is not returned by the backend: flex child sizes are checked, not how they size",
    "opacity and hidden are not returned by the backend: not checked",
    "instance copies below an override key are not compared with their component",
];

/** Largest difference that still counts as equal for numbers. */
const TOLERANCE = 0.01;

/**
 * Absolute position on a page, in page units.
 */
interface Point {
    readonly x: number;
    readonly y: number;
}

/**
 * Tells whether two numbers are equal within the tolerance.
 *
 * @param a - first number
 * @param b - second number
 */
function near(a: number, b: number): boolean {
    return Math.abs(a - b) < TOLERANCE;
}

/**
 * Tells whether two points are equal within the tolerance.
 *
 * @param a - first point
 * @param b - second point
 */
function pointsNear(a: Point, b: Point): boolean {
    return near(a.x, b.x) && near(a.y, b.y);
}

/**
 * Formats a number for the report, rounded to two decimals so that float noise does not show.
 *
 * @param value - number to format
 */
function fmt(value: number): string {
    return String(Number(value.toFixed(2)));
}

/**
 * Formats a point for the report as "x,y".
 *
 * @param point - point to format
 */
function pointText(point: Point): string {
    return `${fmt(point.x)},${fmt(point.y)}`;
}

/**
 * Formats a list of names for the report. An empty list prints as "none".
 *
 * @param names - names in order
 */
function listText(names: readonly string[]): string {
    return names.length === 0 ? "none" : names.join(", ");
}

/**
 * Tells whether two lists of names are equal in order and length.
 *
 * @param a - first list
 * @param b - second list
 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Counts every node of a forest: each node, and all of its descendants.
 *
 * @param nodes - top-level nodes
 */
function countNodes(nodes: readonly NodeModel[]): number {
    return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/**
 * Finds the first node whose normalised name matches, depth first.
 *
 * @param nodes - nodes to search, with their descendants
 * @param name - normalised name to find
 */
function findDescendant(nodes: readonly NodeModel[], name: string): NodeModel | undefined {
    for (const node of nodes) {
        if (normalizeName(node.name) === name) {
            return node;
        }
        const inner = findDescendant(node.children, name);
        if (inner !== undefined) {
            return inner;
        }
    }
    return undefined;
}

/**
 * Gives every spec child its path label. A name used more than once gets a 1-based number, for example "Stat#2".
 *
 * @param children - sibling specs in spec order
 */
function childLabels(children: readonly NodeSpec[]): string[] {
    const totals = new Map<string, number>();
    for (const child of children) {
        const key = normalizeName(nodeName(child));
        totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return children.map((child) => {
        const key = normalizeName(nodeName(child));
        const index = (seen.get(key) ?? 0) + 1;
        seen.set(key, index);
        return (totals.get(key) ?? 1) > 1 ? `${key}#${index}` : key;
    });
}

/**
 * Returns the node type that a model node must have for a spec node.
 *
 * @param spec - any node of the spec
 */
function expectedType(spec: NodeSpec): string {
    switch (spec.kind) {
        case "board": {
            return "board";
        }
        case "instance": {
            return "board";
        }
        case "rect": {
            return "rect";
        }
        case "ellipse": {
            return "ellipse";
        }
        case "text": {
            return "text";
        }
    }
}

/**
 * Sorts model children by their place in a flex layout: by x for a row, by y for a column.
 *
 * @param children - model children in list order
 * @param direction - direction of the flex layout
 */
function sortByFlex(children: readonly NodeModel[], direction: FlexSpec["direction"]): NodeModel[] {
    return [...children].sort((a, b) => (direction === "row" ? a.x - b.x : a.y - b.y));
}

/**
 * Checks a pulled model against the design spec and reports every difference as one row.
 */
export class DesignVerifier {
    private readonly spec: DesignSpec;
    private readonly model: DesignModel;
    private readonly componentSpecs: Map<string, ComponentSpec>;
    private results: CheckResult[] = [];

    /**
     * Creates the verifier.
     *
     * @param spec - the design system the model must match
     * @param model - the model pulled from Penpot
     */
    constructor(spec: DesignSpec, model: DesignModel) {
        this.spec = spec;
        this.model = model;
        const components = spec.families.flatMap((family) => family.components);
        this.componentSpecs = new Map(
            components.map((component) => [normalizeName(component.name), component] as const)
        );
    }

    /**
     * Runs every check in order and returns the report.
     */
    run(): VerifyReport {
        this.results = [];
        this.checkPages();
        this.checkTokens();
        this.checkTypographies();
        this.checkComponents();
        this.checkScreens();
        this.checkNodeCounts();
        const passed = this.results.filter((result) => result.ok).length;
        return {
            results: [...this.results],
            passed,
            failed: this.results.length - passed,
            skipped: [...SKIPPED_NOTES],
        };
    }

    /**
     * Formats a report as a plain text table with one line per check and a summary.
     *
     * @param report - report of one run
     */
    static format(report: VerifyReport): string {
        const header = ["check", "expected", "actual", "status"];
        const rows = report.results.map((result) => [
            clipCell(result.check),
            clipCell(result.expected),
            clipCell(result.actual),
            result.ok ? "ok" : "FAIL",
        ]);
        const table = [header, ...rows];
        const widths = header.map((_, column) => Math.max(...table.map((row) => (row[column] ?? "").length)));
        const lines = table.map((row) =>
            row
                .map((cell, column) => (column === header.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
                .join(" | ")
        );
        lines.push("");
        lines.push(`checks: ${report.results.length}, passed: ${report.passed}, failed: ${report.failed}`);
        for (const note of report.skipped) {
            lines.push(`skipped: ${note}`);
        }
        return lines.join("\n");
    }

    /**
     * Adds one row to the results. A missing actual value prints as "missing" and fails the row.
     *
     * @param check - readable name of the check
     * @param expected - expected value as text
     * @param actual - actual value as text, or null when the model has none
     * @param ok - true when the actual value meets the expected value
     */
    private addRow(check: string, expected: string, actual: string | null, ok: boolean): void {
        this.results.push({ check, expected, actual: actual ?? "missing", ok: actual !== null && ok });
    }

    /**
     * Adds a row that compares two strings exactly.
     *
     * @param check - readable name of the check
     * @param expected - expected string
     * @param actual - actual string, or null or undefined when missing
     */
    private addText(check: string, expected: string, actual: string | null | undefined): void {
        const value = actual ?? null;
        this.addRow(check, expected, value, value === expected);
    }

    /**
     * Adds a row that compares two numbers within the tolerance.
     *
     * @param check - readable name of the check
     * @param expected - expected number
     * @param actual - actual number, or null or undefined when missing
     */
    private addNumber(check: string, expected: number, actual: number | null | undefined): void {
        const value = actual ?? null;
        this.addRow(check, fmt(expected), value === null ? null : fmt(value), value !== null && near(expected, value));
    }

    /**
     * Adds a row that compares the position of a model node with an expected point.
     *
     * @param check - readable name of the check
     * @param expected - expected absolute position
     * @param actual - model node, or undefined when missing
     */
    private addPoint(check: string, expected: Point, actual: NodeModel | undefined): void {
        const shown = actual === undefined ? null : pointText(actual);
        const ok = actual !== undefined && pointsNear(expected, actual);
        this.addRow(check, pointText(expected), shown, ok);
    }

    /**
     * Finds a page of the model by name.
     *
     * @param name - page name
     */
    private findPage(name: string): PageModel | undefined {
        return this.model.pages.find((page) => page.name === name);
    }

    /**
     * Checks the page order and names: the Components page first, then one page per journey.
     */
    private checkPages(): void {
        const names = [
            this.spec.componentPageName,
            ...this.spec.journeys.map((journey) => this.spec.journeyPagePrefix + journey.name),
        ];
        names.forEach((name, index) => {
            this.addText(`page ${index} ${name}`, name, this.model.pages[index]?.name);
        });
    }

    /**
     * Checks the token set, every spec token and the light theme.
     */
    private checkTokens(): void {
        const sets = this.model.tokens.sets;
        const setNames = sets.length === 0 ? null : sets.map((set) => set.name).join(",");
        this.addRow(
            "token set core",
            "core",
            setNames,
            sets.some((set) => set.name === "core")
        );
        for (const token of this.spec.tokens) {
            const type = backendTokenType(token.type);
            const expected = `${type} ${String(token.value)}`;
            const found = this.model.tokens.tokens.find((item) => item.setName === "core" && item.name === token.name);
            const actual = found === undefined ? null : `${found.type} ${found.value}`;
            const ok = found !== undefined && found.type === type && found.value === String(token.value);
            this.addRow(`token ${token.name}`, expected, actual, ok);
        }
        const theme = this.model.tokens.themes.find((item) => item.name === "light");
        const themeText =
            theme === undefined
                ? null
                : `${theme.group}/${theme.sets.join(",")} ${theme.active ? "active" : "inactive"}`;
        this.addText("theme light exists", "mode/core active", themeText);
    }

    /**
     * Checks the size, line height and weight of every text style in the spec.
     */
    private checkTypographies(): void {
        const names = Object.keys(this.spec.typographies) as TypographyName[];
        for (const name of names) {
            const style = this.spec.typographies[name];
            const model = this.model.typographies.find((item) => item.name === name);
            this.addNumber(`typography ${name} fontSize`, Number(style.fontSize), model?.fontSize);
            this.addText(`typography ${name} fontWeight`, style.fontWeight, model?.fontWeight);
            this.addNumber(`typography ${name} lineHeight`, Number(style.lineHeight), model?.lineHeight);
        }
    }

    /**
     * Checks every component: its library entry, its main board on the Components page, its position and its tree.
     */
    private checkComponents(): void {
        const placements = layoutComponentPage(this.spec.families).flatMap((family) => family.components);
        for (const placement of placements) {
            const full = normalizeName(placement.spec.name);
            const library = this.model.components.find((item) => item.fullName === full);
            this.addRow(
                `component ${full} in library`,
                "present",
                library === undefined ? null : "present",
                library !== undefined
            );
            if (library === undefined) {
                continue;
            }
            const main = this.findMainBoard(library.mainInstanceId, full);
            this.addRow(
                `component ${full} main board on Components page`,
                "present",
                main === undefined ? null : "present",
                main !== undefined
            );
            if (main === undefined) {
                continue;
            }
            this.addPoint(`component ${full} position`, placement.at, main);
            this.walk(placement.spec.root, main, placement.at, false, `component ${full}`, true);
        }
    }

    /**
     * Finds the main board of a component on the Components page. The id wins. The name is the fallback.
     *
     * @param mainInstanceId - id of the main instance from the library
     * @param full - normalised full name of the component
     */
    private findMainBoard(mainInstanceId: string, full: string): NodeModel | undefined {
        const boards = this.findPage(this.spec.componentPageName)?.boards ?? [];
        return (
            boards.find((board) => board.id === mainInstanceId) ??
            boards.find((board) => board.type === "board" && normalizeName(board.name) === full)
        );
    }

    /**
     * Checks every journey screen: its board, its origin, its tree and the NavBar and Body offsets.
     */
    private checkScreens(): void {
        for (const journey of this.spec.journeys) {
            const page = this.findPage(this.spec.journeyPagePrefix + journey.name);
            journey.screens.forEach((screen, index) => {
                this.checkScreen(screen, index, page);
            });
        }
    }

    /**
     * Checks one journey screen.
     *
     * @param screen - the screen spec
     * @param index - position of the screen inside its journey
     * @param page - the journey page of the model, or undefined when missing
     */
    private checkScreen(screen: ScreenSpec, index: number, page: PageModel | undefined): void {
        const layout = this.spec.layout;
        const origin: Point = { x: index * (layout.screenWidth + layout.screenColumnGap), y: layout.originY };
        const name = normalizeName(screen.name);
        const board = page?.boards.find((node) => node.type === "board" && normalizeName(node.name) === name);
        this.addRow(`screen ${name} present`, "present", board === undefined ? null : "present", board !== undefined);
        this.addPoint(`screen ${name} position`, origin, board);
        if (board !== undefined) {
            this.walk(screenBoard(screen), board, origin, false, name, true);
        }
        const navBar = board?.children.find((child) => normalizeName(child.name) === "NavBar");
        const body = board?.children.find((child) => normalizeName(child.name) === "Body");
        // The NavBar sits at the top of the screen, the Body under it.
        this.addNumber(`screen ${name} NavBar y`, origin.y, navBar?.y);
        this.addNumber(`screen ${name} Body y`, origin.y + layout.navBarHeight, body?.y);
    }

    /**
     * Checks the node counts of the Components page and of every journey page.
     */
    private checkNodeCounts(): void {
        const components = this.spec.families.flatMap((family) => family.components);
        const componentExpected =
            this.spec.families.length + components.reduce((sum, component) => sum + this.specSize(component.root), 0);
        this.addNumber(
            `node count ${this.spec.componentPageName}`,
            componentExpected,
            this.countOn(this.spec.componentPageName)
        );
        for (const journey of this.spec.journeys) {
            const name = this.spec.journeyPagePrefix + journey.name;
            const expected = journey.screens.reduce((sum, screen) => sum + this.specSize(screenBoard(screen)), 0);
            this.addNumber(`node count ${name}`, expected, this.countOn(name));
        }
    }

    /**
     * Counts the model nodes on a page, or returns undefined when the page is missing.
     *
     * @param pageName - name of the page
     */
    private countOn(pageName: string): number | undefined {
        const page = this.findPage(pageName);
        return page === undefined ? undefined : countNodes(page.boards);
    }

    /**
     * Counts the nodes a spec node produces: itself and its descendants. An instance counts as its component root.
     *
     * @param spec - any node of the spec
     */
    private specSize(spec: NodeSpec): number {
        if (spec.kind === "instance") {
            const component = this.componentSpecs.get(normalizeName(spec.component));
            return component === undefined ? 0 : this.specSize(component.root);
        }
        if (spec.kind === "board") {
            return 1 + (spec.children ?? []).reduce((sum, child) => sum + this.specSize(child), 0);
        }
        return 1;
    }

    /**
     * Returns the width and height the spec gives a node. An instance takes the size of its component root.
     *
     * @param spec - any node of the spec
     */
    private specBox(spec: NodeSpec): { readonly width: number; readonly height: number } | undefined {
        if (spec.kind === "instance") {
            const component = this.componentSpecs.get(normalizeName(spec.component));
            return component === undefined ? undefined : { width: component.root.width, height: component.root.height };
        }
        return { width: spec.width, height: spec.height };
    }

    /**
     * Walks one spec node against its model node. Adds the position, size, type and content rows, then walks the
     * children.
     *
     * @param spec - the spec node
     * @param model - the matched model node
     * @param base - absolute position that the spec node's x and y are relative to
     * @param parentIsFlex - true when the parent spec board has a flex layout
     * @param path - readable path of the node, used in check names
     * @param isRoot - true for a component root or a screen root, whose position has its own row
     */
    private walk(
        spec: NodeSpec,
        model: NodeModel,
        base: Point,
        parentIsFlex: boolean,
        path: string,
        isRoot: boolean
    ): void {
        if (!parentIsFlex && !isRoot) {
            this.addPoint(`${path} position`, { x: base.x + spec.x, y: base.y + spec.y }, model);
        }
        const box = this.specBox(spec);
        const expectedSize = box === undefined ? "no component in spec" : `${fmt(box.width)}x${fmt(box.height)}`;
        const sizeOk = box !== undefined && near(box.width, model.width) && near(box.height, model.height);
        this.addRow(`${path} size`, expectedSize, `${fmt(model.width)}x${fmt(model.height)}`, sizeOk);
        this.addText(`${path} type`, expectedType(spec), model.type);
        switch (spec.kind) {
            case "board": {
                this.walkBoard(spec, model, base, parentIsFlex, path);
                break;
            }
            case "rect": {
                this.walkRect(spec, model, path);
                break;
            }
            case "ellipse": {
                this.walkEllipse(spec, model, path);
                break;
            }
            case "text": {
                this.walkText(spec, model, path);
                break;
            }
            case "instance": {
                this.walkInstance(spec, model, path);
                break;
            }
        }
    }

    /**
     * Checks the fill, stroke, radius and children of a board.
     *
     * @param spec - the board spec
     * @param model - the matched model board
     * @param base - absolute position that the board's x and y are relative to
     * @param parentIsFlex - true when the board is a child of a flex board
     * @param path - readable path of the board
     */
    private walkBoard(spec: BoardNode, model: NodeModel, base: Point, parentIsFlex: boolean, path: string): void {
        this.checkFill(path, spec.fill === undefined ? undefined : this.spec.palette[spec.fill], model, true);
        this.checkStroke(path, spec.stroke, model);
        this.checkRadius(path, spec.radius, model);
        let childBase: Point;
        if (spec.coordinates === "frame") {
            childBase = base;
        } else if (parentIsFlex) {
            // the layout moved this board, so its children follow where it actually sits.
            childBase = { x: model.x, y: model.y };
        } else {
            childBase = { x: base.x + spec.x, y: base.y + spec.y };
        }
        this.walkChildren(spec.children ?? [], spec.flex, model, childBase, path);
    }

    /**
     * Checks the fill, stroke and radius of a rectangle.
     *
     * @param spec - the rectangle spec
     * @param model - the matched model rectangle
     * @param path - readable path of the rectangle
     */
    private walkRect(spec: RectNode, model: NodeModel, path: string): void {
        this.checkFill(path, spec.fill === undefined ? undefined : this.spec.palette[spec.fill], model, false);
        this.checkStroke(path, spec.stroke, model);
        this.checkRadius(path, spec.radius, model);
    }

    /**
     * Checks the fill of an ellipse.
     *
     * @param spec - the ellipse spec
     * @param model - the matched model ellipse
     * @param path - readable path of the ellipse
     */
    private walkEllipse(spec: EllipseNode, model: NodeModel, path: string): void {
        this.checkFill(path, this.spec.palette[spec.fill], model, false);
    }

    /**
     * Checks the characters, font size, weight, line height, colour and alignment of a text.
     *
     * @param spec - the text spec
     * @param model - the matched model text
     * @param path - readable path of the text
     */
    private walkText(spec: TextNode, model: NodeModel, path: string): void {
        const style = this.spec.typographies[spec.typography];
        const text = model.text;
        this.addText(`${path} characters`, spec.characters, text?.characters);
        this.addNumber(`${path} fontSize`, spec.fontSize ?? Number(style.fontSize), text?.fontSize);
        this.addText(`${path} fontWeight`, spec.fontWeight ?? style.fontWeight, text?.fontWeight);
        this.addNumber(`${path} lineHeight`, Number(style.lineHeight), text?.lineHeight);
        this.addText(`${path} fill`, this.spec.palette[spec.color], text?.fill);
        if (spec.align === "center") {
            this.addText(`${path} textAlign`, "center", text?.textAlign);
        }
    }

    /**
     * Checks an instance: its library component, the overrides of its text descendants. Its size comes from the
     * component root, which the caller checks. Its copied children are not walked against the spec.
     *
     * @param spec - the instance spec
     * @param model - the matched model copy
     * @param path - readable path of the instance
     */
    private walkInstance(spec: InstanceNode, model: NodeModel, path: string): void {
        const library = this.model.components.find((item) => item.fullName === normalizeName(spec.component));
        const expectedId = library === undefined ? "missing in library" : library.id;
        this.addText(`${path} component`, expectedId, model.component?.componentId);
        for (const [key, value] of Object.entries(spec.overrides ?? {})) {
            const target = findDescendant(model.children, normalizeName(key));
            this.addText(`${path} text ${key}`, value, target?.text?.characters);
        }
    }

    /**
     * Checks the fill of a node. A node without a spec fill expects no fill when `expectNone` is set.
     *
     * @param path - readable path of the node
     * @param fill - expected fill colour as hex, or undefined when the spec sets none
     * @param model - the matched model node
     * @param expectNone - true when a node without a spec fill must have no fill
     */
    private checkFill(path: string, fill: string | undefined, model: NodeModel, expectNone: boolean): void {
        if (fill !== undefined) {
            const actual = model.fills[0]?.hex ?? "none";
            this.addRow(`${path} fill`, fill, actual, model.fills[0]?.hex === fill);
            return;
        }
        if (expectNone) {
            const hexes = model.fills.map((item) => item.hex);
            this.addRow(`${path} fill`, "none", hexes.length === 0 ? "none" : hexes.join(","), hexes.length === 0);
        }
    }

    /**
     * Checks the first stroke of a node against the spec stroke.
     *
     * @param path - readable path of the node
     * @param stroke - spec stroke, or undefined when the spec sets none
     * @param model - the matched model node
     */
    private checkStroke(path: string, stroke: StrokeSpec | undefined, model: NodeModel): void {
        if (stroke === undefined) {
            return;
        }
        const hex = this.spec.palette[stroke.color];
        const expected = `${hex}/${fmt(stroke.width)}`;
        const first = model.strokes[0];
        const actual =
            first === undefined ? "none" : `${first.hex}/${first.width === null ? "missing" : fmt(first.width)}`;
        const ok = first !== undefined && first.hex === hex && first.width !== null && near(first.width, stroke.width);
        this.addRow(`${path} stroke`, expected, actual, ok);
    }

    /**
     * Checks the corner radii of a node when the spec gives a radius above zero.
     *
     * @param path - readable path of the node
     * @param radius - spec radius, or undefined for square corners
     * @param model - the matched model node
     */
    private checkRadius(path: string, radius: number | undefined, model: NodeModel): void {
        if (radius === undefined || radius <= 0) {
            return;
        }
        const expected = [radius, radius, radius, radius].map((value) => fmt(value)).join(",");
        const values = model.radius;
        const actual = values === null ? "none" : values.map((value) => fmt(value)).join(",");
        const ok = values !== null && values.every((value) => near(value, radius));
        this.addRow(`${path} radius`, expected, actual, ok);
    }

    /**
     * Walks the children of a board. A flex board checks its children in tree order and by layout position. Any other
     * board matches each spec child to the next unused model child with the same name.
     *
     * @param children - spec children in spec order
     * @param flex - flex layout of the spec board, or undefined when it has none
     * @param model - the matched model board
     * @param childBase - absolute position that the children's x and y are relative to
     * @param path - readable path of the board
     */
    private walkChildren(
        children: readonly NodeSpec[],
        flex: FlexSpec | undefined,
        model: NodeModel,
        childBase: Point,
        path: string
    ): void {
        const labels = childLabels(children);
        const expectedNames = children.map((child) => normalizeName(nodeName(child)));
        if (flex !== undefined) {
            // get_page_tree lists the children of a flex board in visual order, so the list order must match the spec.
            const treeNames = model.children.map((child) => normalizeName(child.name));
            this.addRow(
                `${path} children in tree order`,
                listText(expectedNames),
                listText(treeNames),
                sameList(expectedNames, treeNames)
            );
            // The children must also sit in spec order on screen, by their position in the layout.
            const sorted = sortByFlex(model.children, flex.direction);
            const actualNames = sorted.map((child) => normalizeName(child.name));
            this.addRow(
                `${path} children`,
                listText(expectedNames),
                listText(actualNames),
                sameList(expectedNames, actualNames)
            );
            children.forEach((child, index) => {
                const modelChild = sorted[index];
                if (modelChild !== undefined && actualNames[index] === expectedNames[index]) {
                    this.walk(child, modelChild, childBase, true, `${path} > ${labels[index]}`, false);
                }
            });
            return;
        }
        const used = new Set<NodeModel>();
        const matches: (NodeModel | undefined)[] = children.map((child) => {
            const key = normalizeName(nodeName(child));
            const match = model.children.find(
                (candidate) => !used.has(candidate) && normalizeName(candidate.name) === key
            );
            if (match !== undefined) {
                used.add(match);
            }
            return match;
        });
        const actualNames = model.children.map((child) => normalizeName(child.name));
        this.addRow(
            `${path} children`,
            listText(expectedNames),
            listText(actualNames),
            sameList(expectedNames, actualNames)
        );
        children.forEach((child, index) => {
            const match = matches[index];
            if (match === undefined) {
                this.addRow(`${path} child ${labels[index]}`, "present", null, false);
                return;
            }
            this.walk(child, match, childBase, false, `${path} > ${labels[index]}`, false);
        });
    }
}

/**
 * Shortens a table cell to at most 60 characters, so that one long child list does not widen the whole table.
 *
 * @param text - cell text as the result holds it
 */
function clipCell(text: string): string {
    const limit = 60;
    return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
}
