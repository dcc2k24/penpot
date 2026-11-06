import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DesignModel, NodeModel, PageModel } from "./DesignModel.js";
import { DesignNormaliser, type NormaliserInput } from "./Normaliser.js";
import { PACKAGE_ROOT } from "./Paths.js";

/** Id of the root of every page tree. The root is never a node of the model. */
const ROOT_ID = "00000000-0000-0000-0000-000000000000";

/** Name of the one journey page that the fixtures hold. */
const PAGE_NAME = "Journey: Onboarding";

/** Time of the pull that the tests pass to the normaliser. */
const PULLED_AT = "2026-01-01T00:00:00.000Z";

/** Matches a colour of the model: a hash and six upper case hex digits. */
const HEX_FORMAT = /^#[0-9A-F]{6}$/;

/** Loose JSON record, as the backend returns it. */
type JsonRecord = Record<string, unknown>;

/** The normalised model of the fixtures, built once for the tests that read it. */
const MODEL: DesignModel = new DesignNormaliser().normalise(buildInput());

/**
 * Reads a JSON fixture from the fixtures folder of the package.
 *
 * @param name - file name inside the fixtures folder
 */
function readFixture(name: string): JsonRecord {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "fixtures", name), "utf8")) as JsonRecord;
}

/**
 * Finds the id of the onboarding page in the outline fixture.
 *
 * @param outline - outline fixture
 */
function pageIdOf(outline: JsonRecord): string {
    const pages = outline.pages as { id: string; name: string }[];
    const page = pages.find((entry) => entry.name === PAGE_NAME);
    assert.ok(page, `outline fixture has no page "${PAGE_NAME}"`);
    return page.id;
}

/**
 * Builds the raw input of the normaliser from the fixtures.
 *
 * @param omittedIds - shape ids to leave out of the shapes map
 */
function buildInput(omittedIds: readonly string[] = []): NormaliserInput {
    const outline = readFixture("outline.json");
    const tree = readFixture("tree-journey-onboarding.json");
    const shapeRecords = readFixture("shapes-journey-onboarding.json").shapes as JsonRecord[];
    const shapes = new Map<string, JsonRecord>(
        shapeRecords
            .filter((shape) => !omittedIds.includes(String(shape.id)))
            .map((shape) => [String(shape.id), shape] as const)
    );
    return {
        outline,
        trees: new Map<string, JsonRecord>([[pageIdOf(outline), { root: tree.root }]]),
        shapes,
        library: readFixture("library.json"),
        tokens: readFixture("tokens.json"),
        pulledAt: PULLED_AT,
    };
}

/**
 * Returns the only page of a model, and checks its name.
 *
 * @param model - normalised model of the fixtures
 */
function onlyPage(model: DesignModel): PageModel {
    assert.equal(model.pages.length, 1);
    const page = model.pages[0];
    assert.ok(page, "model has no page");
    assert.equal(page.name, PAGE_NAME);
    return page;
}

/**
 * Lists every node of a forest, depth first. A node comes before its children.
 *
 * @param nodes - top-level nodes to walk
 */
function allNodes(nodes: readonly NodeModel[]): NodeModel[] {
    return nodes.flatMap((node) => [node, ...allNodes(node.children)]);
}

/**
 * Finds the first node with a name in a forest, depth first. Fails the test when no node has the name.
 *
 * @param nodes - top-level nodes to search
 * @param name - name of the node
 */
function requireNode(nodes: readonly NodeModel[], name: string): NodeModel {
    const found = allNodes(nodes).find((node) => node.name === name);
    assert.ok(found, `node "${name}" is missing`);
    return found;
}

/**
 * Lists the colours of one node: its fills, its strokes and the colour of its text, where present.
 *
 * @param node - node of the model
 */
function colourValues(node: NodeModel): string[] {
    const values: (string | null)[] = [
        ...node.fills.map((fill) => fill.hex),
        ...node.strokes.map((stroke) => stroke.hex),
        node.text?.fill ?? null,
    ];
    return values.filter((value): value is string => value !== null);
}

/**
 * Checks that every child names its parent as parentId, at every depth below a node.
 *
 * @param parent - node whose children are checked
 */
function assertChildParents(parent: NodeModel): void {
    for (const child of parent.children) {
        assert.equal(child.parentId, parent.id, `${child.name} does not point at its parent ${parent.name}`);
        assertChildParents(child);
    }
}

describe("DesignNormaliser on the onboarding fixtures", () => {
    it("keeps the page root out of the model and makes one board per root child", () => {
        const page = onlyPage(MODEL);
        const rootChildren = (readFixture("tree-journey-onboarding.json").root as { children: unknown[] }).children;
        assert.ok(rootChildren.length > 0, "tree fixture has no root children");
        assert.equal(page.boards.length, rootChildren.length);
        for (const node of allNodes(page.boards)) {
            assert.notEqual(node.id, ROOT_ID, `page root appears as node ${node.name}`);
        }
    });

    it("sets parentId to null for boards and to the parent id for every child", () => {
        const page = onlyPage(MODEL);
        for (const board of page.boards) {
            assert.equal(board.parentId, null, `board ${board.name} has a parent`);
            assertChildParents(board);
        }
        assert.ok(
            allNodes(page.boards).some((node) => node.children.length > 0),
            "no node has children, so the parent check proves nothing"
        );
    });

    it("gives absolute page coordinates to a screen and to its children", () => {
        const page = onlyPage(MODEL);
        const welcome = requireNode(page.boards, "Onboarding / Welcome");
        assert.equal(welcome.x, 0);
        assert.equal(welcome.y, 0);
        const body = requireNode(welcome.children, "Body");
        assert.equal(body.y, 64);
        const headline = requireNode(body.children, "Headline");
        assert.equal(headline.x, 360);
        assert.equal(headline.y, 240);
    });

    it("writes every colour as an upper case #RRGGBB value", () => {
        const colours = allNodes(onlyPage(MODEL).boards).flatMap((node) => colourValues(node));
        assert.ok(colours.length > 0, "the model holds no colour");
        for (const colour of colours) {
            assert.match(colour, HEX_FORMAT);
        }
    });

    it("keeps a corner radius of 8 on every corner of the NavBar logo", () => {
        const logo = requireNode(onlyPage(MODEL).boards, "Logo");
        assert.deepEqual(logo.radius, [8, 8, 8, 8]);
    });

    it("reads the characters, font size and weight of the headline from its text run", () => {
        const headline = requireNode(onlyPage(MODEL).boards, "Headline");
        assert.equal(headline.type, "text");
        const text = headline.text;
        assert.ok(text !== null, "headline has no text");
        assert.equal(text.characters, "Welcome to Design Lab");
        assert.equal(typeof text.fontSize, "number");
        assert.equal(text.fontSize, 48);
        assert.equal(text.fontWeight, "700");
    });

    it("normalises the 47 library components and names each by its full name", () => {
        assert.equal(MODEL.components.length, 47);
        const button = MODEL.components.find((component) => component.fullName === "Button/Primary/MD");
        assert.ok(button, "component Button/Primary/MD is missing");
        assert.equal(button.name, "MD");
        assert.equal(button.path, "Button / Primary");
    });

    it("reads the active theme and set names and the 53 tokens of the core set", () => {
        assert.deepEqual(MODEL.tokens.activeThemes, ["light"]);
        assert.deepEqual(MODEL.tokens.activeSets, ["core"]);
        const coreTokens = MODEL.tokens.tokens.filter((token) => token.setName === "core");
        assert.equal(coreTokens.length, 53);
    });

    it("keeps a headline that has no shape, with its position from the tree", () => {
        const headlineId = requireNode(onlyPage(MODEL).boards, "Headline").id;
        const fallback = new DesignNormaliser().normalise(buildInput([headlineId]));
        const headline = requireNode(onlyPage(fallback).boards, "Headline");
        assert.equal(headline.type, "text");
        assert.equal(headline.x, 360);
        assert.equal(headline.y, 240);
        // the tree node holds no characters and no font data, so the text keeps empty values.
        assert.equal(headline.text?.characters, "");
        assert.equal(headline.text?.fontSize, null);
    });

    it("gives a stroke no alignment when the backend sends none", () => {
        const inputBox = requireNode(onlyPage(MODEL).boards, "Input Box");
        assert.ok(inputBox.strokes.length > 0, "Input Box has no stroke");
        for (const stroke of inputBox.strokes) {
            assert.equal(stroke.alignment, null);
        }
    });

    it("reads the stroke alignment that the backend sends, and gives null for an unknown value", () => {
        const navBarId = "ce1379a2-f81f-8121-8008-e4e64ae8c3f1";
        for (const [sent, expected] of [
            ["outer", "outer"],
            ["sideways", null],
        ] as const) {
            const input = buildInput();
            const shape = input.shapes.get(navBarId);
            assert.ok(shape, "NavBar shape is missing from the fixture");
            const strokes = shape.strokes as JsonRecord[];
            strokes[0].strokeAlignment = sent;
            const model = new DesignNormaliser().normalise(input);
            const navBar = allNodes(onlyPage(model).boards).find((node) => node.id === navBarId);
            assert.ok(navBar, "NavBar node is missing from the model");
            assert.equal(navBar.strokes[0]?.alignment, expected);
        }
    });

    it("reads the text alignment from the paragraph, not from the text run", () => {
        const headline = textNodeWithContent({
            type: "paragraph",
            textAlign: "center",
            children: [{ text: "Welcome", textAlign: "left" }],
        });
        assert.equal(headline.text?.textAlign, "center");
    });

    it("falls back to the text run alignment when no paragraph states one", () => {
        const headline = textNodeWithContent({
            type: "paragraph",
            children: [{ text: "Welcome", textAlign: "right" }],
        });
        assert.equal(headline.text?.textAlign, "right");
    });

    it("reads the vertical alignment from the content root, and gives null without one", () => {
        const paragraph = { type: "paragraph", textAlign: "center", children: [{ text: "Welcome" }] };
        assert.equal(textNodeWithContent(paragraph, "center").text?.verticalAlign, "center");
        assert.equal(textNodeWithContent(paragraph).text?.verticalAlign, null);
    });

    it("reads the line height of the paragraph, not the line height of the run", () => {
        const headline = textNodeWithContent({
            type: "paragraph",
            lineHeight: "1.2",
            children: [{ text: "Welcome", lineHeight: "1.4" }],
        });
        assert.equal(headline.text?.paragraphLineHeight, 1.2);
    });

    it("gives a null paragraph line height when no paragraph states one", () => {
        const headline = textNodeWithContent({ type: "paragraph", children: [{ text: "Welcome" }] });
        assert.equal(headline.text?.paragraphLineHeight, null);
    });

    it("reads the font style of the text run", () => {
        const headline = textNodeWithContent({
            type: "paragraph",
            children: [{ text: "Welcome", fontStyle: "italic" }],
        });
        assert.equal(headline.text?.fontStyle, "italic");
    });

    it("reads the grow type of the text shape", () => {
        const paragraph = { type: "paragraph", children: [{ text: "Welcome" }] };
        assert.equal(textNodeWithContent(paragraph, undefined, "auto-width").text?.growType, "auto-width");
    });

    it("maps an ellipse to the ellipse type, whether the backend says ellipse or circle", () => {
        const rect = allNodes(onlyPage(MODEL).boards).find((node) => node.type === "rect");
        assert.ok(rect, "the fixture has no rect node");
        for (const raw of ["ellipse", "circle"]) {
            const input = buildInput();
            const shape = input.shapes.get(rect.id);
            assert.ok(shape, `shape ${rect.id} is missing from the fixture`);
            shape.type = raw;
            const model = new DesignNormaliser().normalise(input);
            const found: NodeModel | undefined = allNodes(onlyPage(model).boards).find((item) => item.id === rect.id);
            assert.equal(found?.type, "ellipse", `raw type "${raw}" must map to ellipse`);
        }
    });
});

/**
 * Normalises the fixtures with the content of the Headline shape replaced, and returns the Headline node.
 *
 * @param paragraph - paragraph that holds the text run of the content
 * @param verticalAlign - vertical alignment of the content root, when given
 * @param growType - grow type of the Headline shape, when given
 */
function textNodeWithContent(paragraph: JsonRecord, verticalAlign?: string, growType?: string): NodeModel {
    const input = buildInput();
    const headlineId = requireNode(onlyPage(MODEL).boards, "Headline").id;
    const shape = input.shapes.get(headlineId);
    assert.ok(shape, "Headline shape is missing from the fixture");
    shape.content = {
        type: "root",
        ...(verticalAlign === undefined ? {} : { verticalAlign }),
        children: [{ type: "paragraph-set", children: [paragraph] }],
    };
    if (growType !== undefined) {
        shape.growType = growType;
    }
    const model = new DesignNormaliser().normalise(input);
    return requireNode(onlyPage(model).boards, "Headline");
}
