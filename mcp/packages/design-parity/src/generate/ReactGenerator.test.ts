import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { DesignModel, NodeModel, StrokeModel, TextModel } from "../DesignModel.js";
import { FONT_FILES } from "../FontMap.js";
import { ReactGenerator } from "./ReactGenerator.js";

/** Pulled model that the tests read. */
const FIXTURE = fileURLToPath(new URL("../../fixtures/design.json", import.meta.url));

/** Golden copy of the ButtonPrimaryMD module. Create it with UPDATE_GOLDEN=1. */
const GOLDEN = fileURLToPath(new URL("./testdata/ButtonPrimaryMD.golden.tsx", import.meta.url));

describe("ReactGenerator", () => {
    it("writes the ButtonPrimaryMD module that equals the golden file", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            new ReactGenerator(loadFixture(), dir, fonts).generate();
            const generated = readFileSync(join(dir, "src", "components", "ButtonPrimaryMD.tsx"), "utf8");
            if (process.env.UPDATE_GOLDEN === "1") {
                mkdirSync(dirname(GOLDEN), { recursive: true });
                writeFileSync(GOLDEN, generated, "utf8");
            }
            assert.equal(generated, readFileSync(GOLDEN, "utf8"));
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("writes the same file tree when it runs twice on the same model", () => {
        const model = loadFixture();
        const first = tempDir();
        const second = tempDir();
        const fonts = fontSource();
        try {
            const summary = new ReactGenerator(model, first, fonts).generate();
            new ReactGenerator(model, second, fonts).generate();
            const tree = readTree(first);
            assert.deepEqual(tree, readTree(second));
            assert.deepEqual(Object.keys(tree), summary.files);
        } finally {
            rmSync(first, { recursive: true, force: true });
            rmSync(second, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("lists the children of a flex container in x order", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            const summary = new ReactGenerator(rowModel(), dir, fonts).generate();
            assert.deepEqual(summary.warnings, []);
            const source = readFileSync(join(dir, "src", "components", "Row.tsx"), "utf8");
            const first = source.indexOf('data-node-name={"A"}');
            const second = source.indexOf('data-node-name={"B"}');
            const third = source.indexOf('data-node-name={"C"}');
            assert.ok(first > 0 && second > first && third > second, "A, B and C must appear in x order");
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("writes an index.html without a Google Fonts URL and links the token and typography stylesheets", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            new ReactGenerator(loadFixture(), dir, fonts).generate();
            const html = readFileSync(join(dir, "index.html"), "utf8");
            assert.ok(!html.includes("googleapis"), "index.html must not load Google Fonts");
            assert.ok(html.includes('href="/src/tokens.css"'), "index.html must link tokens.css");
            assert.ok(html.includes('href="/src/typography.css"'), "index.html must link typography.css");
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("lists the typography stylesheet among the written files", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            const summary = new ReactGenerator(loadFixture(), dir, fonts).generate();
            assert.ok(summary.files.includes("src/typography.css"), "src/typography.css must be listed");
            assert.ok(existsSync(join(dir, "src", "typography.css")), "src/typography.css must be written");
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("copies every font file of the table into public/fonts and lists the copies", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            const summary = new ReactGenerator(loadFixture(), dir, fonts).generate();
            for (const font of FONT_FILES) {
                const path = `public/fonts/${font.file}`;
                assert.ok(summary.files.includes(path), `${path} must be listed`);
                assert.equal(
                    readFileSync(join(dir, "public", "fonts", font.file), "utf8"),
                    readFileSync(join(fonts, font.file), "utf8")
                );
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });

    it("throws and names the missing font file before it writes the app", () => {
        const dir = tempDir();
        const fonts = fontSource();
        try {
            rmSync(join(fonts, "sourcesanspro-bold.woff"));
            assert.throws(
                () => new ReactGenerator(loadFixture(), dir, fonts).generate(),
                (error: Error) =>
                    error.message.includes(join(fonts, "sourcesanspro-bold.woff")) &&
                    error.message.includes("PENPOT_FONT_DIR")
            );
            assert.equal(existsSync(join(dir, "src", "typography.css")), false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(fonts, { recursive: true, force: true });
        }
    });
});

describe("ReactGenerator strokes", () => {
    it("draws a 1px stroke as one box shadow for an inner or outer stroke, and two for a centred one", () => {
        const expected: [StrokeModel["alignment"], string][] = [
            ["inner", 'boxShadow: "inset 0 0 0 1px #FF0000",'],
            ["center", 'boxShadow: "inset 0 0 0 0.5px #FF0000, 0 0 0 0.5px #FF0000",'],
            ["outer", 'boxShadow: "0 0 0 1px #FF0000",'],
        ];
        for (const [alignment, line] of expected) {
            const { source, warnings } = generateStroked(strokedModel([stroke(1, alignment)]));
            assert.deepEqual(warnings, []);
            assert.ok(styleLines(source).includes(line), `${alignment}: ${line}`);
            assert.doesNotMatch(source, /outline/);
        }
    });

    it("gives an inner, a centred and an outer stroke of width 2 the shadows 2px, 1px + 1px and 2px", () => {
        const expected: [StrokeModel["alignment"], string][] = [
            ["inner", 'boxShadow: "inset 0 0 0 2px #FF0000",'],
            ["center", 'boxShadow: "inset 0 0 0 1px #FF0000, 0 0 0 1px #FF0000",'],
            ["outer", 'boxShadow: "0 0 0 2px #FF0000",'],
        ];
        for (const [alignment, line] of expected) {
            const { source } = generateStroked(strokedModel([stroke(2, alignment)]));
            assert.ok(styleLines(source).includes(line), alignment ?? "null");
        }
    });

    it("centres a stroke whose alignment is null", () => {
        const { source } = generateStroked(strokedModel([stroke(2, null)]));
        assert.ok(styleLines(source).includes('boxShadow: "inset 0 0 0 1px #FF0000, 0 0 0 1px #FF0000",'));
    });

    it("writes no box shadow and no border for a node without a stroke", () => {
        const { source } = generateStroked(strokedModel([]));
        assert.doesNotMatch(source, /boxShadow/);
        assert.doesNotMatch(source, /outline/);
        assert.doesNotMatch(source, /\bborder\s*:/);
    });

    it("writes no border key for a node with a stroke", () => {
        const { source } = generateStroked(strokedModel([stroke(2, "inner")]));
        assert.doesNotMatch(source, /\bborder\s*:/);
    });

    it("places a child of a stroked board at the same left and top as without the stroke", () => {
        const child = node({ id: "child", name: "Child", type: "rect", parentId: "board", x: 20, y: 30 });
        const plain = generateStroked(strokedModel([], [child]));
        const stroked = generateStroked(strokedModel([stroke(4, "center")], [child]));
        assert.deepEqual(stroked.warnings, []);
        assert.deepEqual(placementLines(stroked.source, "Child"), ["left: 20,", "top: 30,"]);
        assert.deepEqual(placementLines(stroked.source, "Child"), placementLines(plain.source, "Child"));
    });
});

describe("ReactGenerator text", () => {
    it("wraps a text in a root flex box, a paragraph-set, a paragraph and a span, as Penpot does", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const { source, warnings } = generateStroked(strokedModel([], [{ ...label, text: textRecord(null) }]));
        assert.deepEqual(warnings, []);
        const lines = styleLines(source);
        const root = source.indexOf('data-node-name={"Label"}');
        assert.ok(root >= 0, "the root must carry the node name");
        const tags = [...source.slice(source.lastIndexOf("<div", root)).matchAll(/<(div|p|span)\b/g)].map(
            (match) => match[1]
        );
        assert.deepEqual(tags.slice(0, 4), ["div", "div", "p", "span"], "the element order must match Penpot");
        assert.ok(lines.includes('display: "flex",'), "the root must be a flex box");
        assert.ok(lines.includes('whiteSpace: "break-spaces",'), "the root must keep the spaces");
        assert.ok(lines.includes('alignItems: "flex-start",'), "a missing alignment puts the paragraph-set at the top");
        assert.ok(lines.includes('display: "inline-flex",'), "the paragraph-set must be an inline flex box");
        assert.ok(lines.includes('flexDirection: "column",'), "the paragraph-set must stack its paragraphs");
        assert.ok(lines.includes('justifyContent: "inherit",'), "the paragraph-set must inherit the justification");
        assert.ok(lines.includes('minWidth: "100%",'), "a fixed text paragraph-set fills the width of the box");
        assert.ok(lines.includes('marginRight: "1px",'), "the paragraph-set has a 1px right margin");
        assert.ok(lines.includes('verticalAlign: "top",'), "the paragraph-set is aligned to the top of its line");
        assert.ok(lines.includes('dir="auto"'), "the paragraph must have dir auto");
        assert.ok(lines.includes("fontSize: 0,"), "the paragraph must have font size 0");
        assert.ok(lines.includes("lineHeight: 1.2,"), "a paragraph without a line height uses 1.2");
        assert.ok(lines.includes('textAlign: "center",'), "the paragraph carries the horizontal alignment");
        assert.ok(lines.includes('data-text-leaf=""'), "the span must be marked as a text leaf");
        assert.ok(lines.includes('fontSize: "14px",'), "the span carries the font size in px");
        assert.ok(lines.includes('textDecoration: "none",'), "the span has no decoration");
        assert.ok(lines.includes('overflowWrap: "initial",'), "the span does not wrap inside words");
        assert.ok(lines.includes('lineBreak: "auto",'), "the span uses the default line breaking");
        assert.ok(lines.includes('whiteSpace: "break-spaces",'), "a fixed text keeps its spaces");
        assert.ok(lines.includes('textRendering: "geometricPrecision",'), "the span uses geometric precision");
        assert.ok(lines.includes('fontFamily: "\\"sourcesanspro\\"",'), "the span uses the Penpot family name");
        assert.ok(lines.includes('fontStyle: "normal",'), "the span has the font style of its run");
        assert.ok(lines.includes("fontWeight: 400,"), "the span has the numeric weight of its run");
        const rootBlock = source.slice(source.lastIndexOf("<div", root), source.indexOf("<div", root + 1));
        assert.doesNotMatch(rootBlock, /font|color|lineHeight/, "the root must carry no font or colour");
        assert.ok(rootBlock.includes("data-node-id"), "the root carries the node id");
        const spanBlock = source.slice(source.indexOf("<span", root), source.indexOf("</span>", root));
        assert.doesNotMatch(spanBlock, /data-node-id|lineHeight/, "the span carries no node id and no line height");
    });

    it("aligns the paragraph-set in the root at the vertical alignment of the text", () => {
        const cases: [string | null, string][] = [
            [null, "flex-start"],
            ["top", "flex-start"],
            ["center", "center"],
            ["bottom", "flex-end"],
        ];
        for (const [valign, expected] of cases) {
            const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
            const { source, warnings } = generateStroked(strokedModel([], [{ ...label, text: textRecord(valign) }]));
            assert.deepEqual(warnings, []);
            assert.ok(styleLines(source).includes(`alignItems: "${expected}",`), `${valign ?? "null"} is ${expected}`);
        }
    });

    it("keeps the box size on the root and the horizontal alignment on the paragraph", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const { source } = generateStroked(strokedModel([], [{ ...label, text: textRecord("center") }]));
        const lines = styleLines(source);
        assert.ok(lines.includes("width: 80,") && lines.includes("height: 20,"), "the box keeps its size");
        assert.ok(lines.includes('textAlign: "center",'), "the horizontal alignment stays as it is");
    });

    it("lets an auto-width text grow with its characters", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const text = { ...textRecord(null), growType: "auto-width" };
        const { source, warnings } = generateStroked(strokedModel([], [{ ...label, text }]));
        assert.deepEqual(warnings, []);
        const lines = styleLines(source);
        assert.ok(lines.includes('whiteSpace: "pre",'), "an auto-width span does not wrap");
        assert.ok(!lines.some((line) => line.startsWith("minWidth")), "an auto-width paragraph-set has no min width");
    });

    it("uses the paragraph line height, and not the run line height, on the paragraph", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const withParagraph = { ...textRecord(null), lineHeight: 1.4, paragraphLineHeight: 1.6 };
        const first = generateStroked(strokedModel([], [{ ...label, text: withParagraph }]));
        assert.ok(styleLines(first.source).includes("lineHeight: 1.6,"), "the paragraph line height is used");
        assert.ok(!styleLines(first.source).includes("lineHeight: 1.4,"), "the run line height is not used");
    });

    it("writes the italic font style of a run", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const text = { ...textRecord(null), fontStyle: "italic" };
        const { source } = generateStroked(strokedModel([], [{ ...label, text }]));
        assert.ok(styleLines(source).includes('fontStyle: "italic",'), "the span is italic");
    });

    it("holds a no-break space in a text with no characters", () => {
        const label = node({ id: "label", name: "Label", type: "text", parentId: "board", width: 80, height: 20 });
        const text = { ...textRecord(null), characters: "" };
        const { source } = generateStroked(strokedModel([], [{ ...label, text }]));
        assert.ok(source.includes('?? "\\u00a0"}'), "an empty text falls back to a no-break space");
    });
});

/**
 * Builds the text record of a label: 14px Source Sans Pro, centred, with the given vertical alignment.
 *
 * @param verticalAlign - vertical alignment of the text box, or null when the design gives none
 */
function textRecord(verticalAlign: string | null): TextModel {
    return {
        characters: "Label",
        fontFamily: "Source Sans Pro",
        fontSize: 14,
        fontWeight: "400",
        fontStyle: "normal",
        lineHeight: 1.5,
        paragraphLineHeight: null,
        letterSpacing: 0,
        textAlign: "center",
        verticalAlign,
        fill: "#000000",
        growType: "fixed",
    };
}

/**
 * Creates an empty folder in the system temp directory.
 */
function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "design-parity-gen-"));
}

/**
 * Creates a folder in the system temp directory that holds one file for each row of the font table.
 */
function fontSource(): string {
    const dir = tempDir();
    for (const font of FONT_FILES) {
        writeFileSync(join(dir, font.file), `bytes of ${font.file}`, "utf8");
    }
    return dir;
}

/**
 * Reads the pulled model of the fixture.
 */
function loadFixture(): DesignModel {
    return JSON.parse(readFileSync(FIXTURE, "utf8")) as DesignModel;
}

/**
 * Reads every file under a folder, keyed by its path relative to the folder with forward slashes, sorted.
 *
 * @param root - folder to read
 */
function readTree(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (folder: string): void => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else {
                const key = path
                    .slice(root.length + 1)
                    .split("\\")
                    .join("/");
                files[key] = readFileSync(path, "utf8");
            }
        }
    };
    walk(root);
    return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Creates a node with empty values for everything the test does not set.
 *
 * @param partial - values to set
 */
function node(partial: Partial<NodeModel> & Pick<NodeModel, "id" | "name" | "type">): NodeModel {
    return {
        parentId: null,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        rotation: null,
        hidden: null,
        opacity: null,
        fills: [],
        strokes: [],
        radius: null,
        layout: null,
        layoutItem: null,
        text: null,
        component: null,
        children: [],
        ...partial,
    };
}

/**
 * Builds a model with one component whose row holds three rects in the order C, A, B by list, and x positions A, B, C.
 */
function rowModel(): DesignModel {
    const row = node({
        id: "board",
        name: "Row",
        type: "board",
        width: 300,
        height: 40,
        fills: [{ hex: "#FFFFFF", opacity: 1 }],
        layout: {
            dir: "row",
            gap: { row: 0, column: 0 },
            padding: [0, 0, 0, 0],
            alignItems: "start",
            justifyContent: "start",
            wrap: "nowrap",
        },
        component: { componentId: "row-component", mainInstance: true, componentRoot: true },
        children: [
            node({ id: "c", name: "C", type: "rect", parentId: "board", x: 200 }),
            node({ id: "a", name: "A", type: "rect", parentId: "board", x: 0 }),
            node({ id: "b", name: "B", type: "rect", parentId: "board", x: 100 }),
        ],
    });
    return {
        formatVersion: 1,
        file: { id: "file", name: "Test", revn: null, projectId: null },
        pulledAt: "2026-01-01T00:00:00.000Z",
        pages: [{ id: "page", name: "Components", index: 0, boards: [row] }],
        components: [
            {
                id: "row-component",
                name: "Row",
                path: "",
                fullName: "Row",
                mainInstanceId: "board",
                mainInstancePageId: "page",
            },
        ],
        typographies: [],
        tokens: { sets: [], themes: [], tokens: [], activeThemes: [], activeSets: [] },
    };
}

/**
 * Builds a stroke of the given width and alignment, in the colour #FF0000.
 *
 * @param width - width of the stroke in pixels
 * @param alignment - alignment of the stroke, or null when the design gives none
 */
function stroke(width: number, alignment: StrokeModel["alignment"]): StrokeModel {
    return { hex: "#FF0000", opacity: 1, width, alignment };
}

/**
 * Builds a model with one component named "Stroked", a board with the given strokes and children.
 *
 * @param strokes - strokes of the board
 * @param children - children of the board, each with parentId "board"
 */
function strokedModel(strokes: StrokeModel[], children: NodeModel[] = []): DesignModel {
    const board = node({
        id: "board",
        name: "Stroked",
        type: "board",
        width: 100,
        height: 100,
        fills: [{ hex: "#FFFFFF", opacity: 1 }],
        strokes,
        component: { componentId: "stroked-component", mainInstance: true, componentRoot: true },
        children,
    });
    return {
        formatVersion: 1,
        file: { id: "file", name: "Test", revn: null, projectId: null },
        pulledAt: "2026-01-01T00:00:00.000Z",
        pages: [{ id: "page", name: "Components", index: 0, boards: [board] }],
        components: [
            {
                id: "stroked-component",
                name: "Stroked",
                path: "",
                fullName: "Stroked",
                mainInstanceId: "board",
                mainInstancePageId: "page",
            },
        ],
        typographies: [],
        tokens: { sets: [], themes: [], tokens: [], activeThemes: [], activeSets: [] },
    };
}

/**
 * Generates the module of the "Stroked" component of a model, and returns its source and warnings.
 *
 * @param model - model built by strokedModel
 */
function generateStroked(model: DesignModel): { source: string; warnings: string[] } {
    const dir = tempDir();
    try {
        const summary = new ReactGenerator(model, dir).generate();
        const source = readFileSync(join(dir, "src", "components", "Stroked.tsx"), "utf8");
        return { source, warnings: summary.warnings };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/**
 * Lists the trimmed lines of a generated module, so that a test can match one style entry.
 *
 * @param source - generated module
 */
function styleLines(source: string): string[] {
    return source.split("\n").map((line) => line.trim());
}

/**
 * Lists the left and top entries of the style of the element with a node name, in source order.
 *
 * @param source - generated module
 * @param name - node name of the element
 */
function placementLines(source: string, name: string): string[] {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.includes(`data-node-name={${JSON.stringify(name)}}`));
    assert.ok(start >= 0, `element ${name} is missing from the module`);
    const rest = lines.slice(start);
    const close = rest.findIndex((line) => line.trim() === "}}");
    return rest
        .slice(0, close)
        .map((line) => line.trim())
        .filter((line) => /^(left|top):/.test(line));
}
