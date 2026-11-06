import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    DESIGN_SPEC,
    TYPOGRAPHIES,
    fontVariantIdOf,
    instanceReferences,
    layoutComponentPage,
    normalizeName,
    screenBoard,
    type BoardNode,
    type ComponentSpec,
    type NodeSpec,
    type ScreenSpec,
} from "./DesignSpec.js";

/** Every component of the spec, in page order. */
const COMPONENTS: readonly ComponentSpec[] = DESIGN_SPEC.families.flatMap((family) => family.components);

/** Every screen of the spec, in journey order. */
const SCREENS: readonly ScreenSpec[] = DESIGN_SPEC.journeys.flatMap((journey) => journey.screens);

/** Normalised name of every component. */
const COMPONENT_NAMES: ReadonlySet<string> = new Set(COMPONENTS.map((spec) => normalizeName(spec.name)));

/**
 * Returns the size of a node. An instance takes the size of its component.
 *
 * @param node - any node of the spec
 */
function sizeOf(node: NodeSpec): { width: number; height: number } {
    if (node.kind === "instance") {
        const component = COMPONENTS.find((spec) => normalizeName(spec.name) === normalizeName(node.component));
        assert.ok(component, `instance of unknown component ${node.component}`);
        return { width: component.root.width, height: component.root.height };
    }
    return { width: node.width, height: node.height };
}

/**
 * Checks that every child of a board lies inside it. Children of an auto layout board are skipped, because the layout
 * moves them. Frame coordinates are converted to the board's own origin first.
 *
 * @param board - the board whose children are checked
 * @param problems - receives one line per child outside its parent
 */
function collectOutsideChildren(board: BoardNode, problems: string[]): void {
    for (const child of board.children ?? []) {
        if (board.flex === undefined) {
            const offsetX = board.coordinates === "frame" ? board.x : 0;
            const offsetY = board.coordinates === "frame" ? board.y : 0;
            const relX = child.x - offsetX;
            const relY = child.y - offsetY;
            const size = sizeOf(child);
            const inside =
                relX >= 0 && relY >= 0 && relX + size.width <= board.width && relY + size.height <= board.height;
            if (!inside) {
                problems.push(`${nodeLabel(child)} is outside ${board.name}`);
            }
        }
        if (child.kind === "board") {
            collectOutsideChildren(child, problems);
        }
    }
}

/**
 * Returns a label for a node, used in failure messages.
 *
 * @param node - any node of the spec
 */
function nodeLabel(node: NodeSpec): string {
    return node.kind === "instance" ? `instance ${node.component}` : `${node.kind} ${node.name}`;
}

/**
 * Lists every node of a subtree, the subtree root included.
 *
 * @param node - root of the subtree
 */
function allNodes(node: NodeSpec): NodeSpec[] {
    const nested = node.kind === "board" ? (node.children ?? []).flatMap((child) => allNodes(child)) : [];
    return [node, ...nested];
}

describe("DesignSpec names", () => {
    it("gives every component a unique name across the file", () => {
        const names = COMPONENTS.map((spec) => normalizeName(spec.name));
        assert.equal(new Set(names).size, names.length);
    });

    it("gives every component in a family a unique name", () => {
        for (const family of DESIGN_SPEC.families) {
            const names = family.components.map((spec) => normalizeName(spec.name));
            assert.equal(new Set(names).size, names.length, `duplicate name in family ${family.title}`);
        }
    });

    it("builds the 47 main components the spec asks for", () => {
        assert.equal(COMPONENTS.length, 47);
    });

    it("gives every screen a unique full name across the journeys", () => {
        const names = SCREENS.map((screen) => normalizeName(screen.name));
        assert.equal(new Set(names).size, names.length);
        assert.equal(SCREENS.length, 12);
    });

    it("gives every journey screen the journey and screen separated by a slash", () => {
        for (const screen of SCREENS) {
            assert.match(screen.name, / \/ /, `screen name ${screen.name} has no journey part`);
        }
    });
});

describe("DesignSpec sizes", () => {
    it("gives every component and every shape a positive size", () => {
        for (const spec of COMPONENTS) {
            for (const node of allNodes(spec.root)) {
                const size = sizeOf(node);
                assert.ok(size.width > 0 && size.height > 0, `${nodeLabel(node)} in ${spec.name} has no size`);
            }
        }
        for (const screen of SCREENS) {
            for (const node of allNodes(screenBoard(screen))) {
                const size = sizeOf(node);
                assert.ok(size.width > 0 && size.height > 0, `${nodeLabel(node)} in ${screen.name} has no size`);
            }
        }
    });
});

describe("DesignSpec containment", () => {
    it("keeps every child inside its parent for parents without auto layout", () => {
        const problems: string[] = [];
        for (const spec of COMPONENTS) {
            collectOutsideChildren(spec.root, problems);
        }
        for (const screen of SCREENS) {
            collectOutsideChildren(screenBoard(screen), problems);
        }
        assert.deepEqual(problems, []);
    });

    it("does not overlap components on the Components page", () => {
        const boxes: { name: string; x: number; y: number; width: number; height: number }[] = [];
        for (const family of layoutComponentPage(DESIGN_SPEC.families)) {
            for (const item of family.components) {
                boxes.push({
                    name: item.spec.name,
                    x: item.at.x,
                    y: item.at.y,
                    width: item.spec.root.width,
                    height: item.spec.root.height,
                });
            }
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i];
                const b = boxes[j];
                if (a === undefined || b === undefined) {
                    continue;
                }
                const overlaps =
                    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
                assert.ok(!overlaps, `${a.name} overlaps ${b.name}`);
            }
        }
    });
});

describe("DesignSpec references", () => {
    it("refers only to components that exist from a screen", () => {
        for (const screen of SCREENS) {
            for (const reference of instanceReferences(screenBoard(screen))) {
                assert.ok(COMPONENT_NAMES.has(reference), `${screen.name} uses unknown component ${reference}`);
            }
        }
    });

    it("refers only to existing components from every instance inside SideBar", () => {
        const sideBar = COMPONENTS.find((spec) => normalizeName(spec.name) === "SideBar");
        assert.ok(sideBar, "SideBar component is missing");
        const navItems = instanceReferences(sideBar.root).filter((reference) => reference.startsWith("NavItem/"));
        assert.equal(navItems.length, 5);
        for (const reference of navItems) {
            assert.ok(COMPONENT_NAMES.has(reference), `SideBar uses unknown component ${reference}`);
        }
    });

    it("uses only palette entries and text styles that exist", () => {
        for (const spec of COMPONENTS) {
            for (const node of allNodes(spec.root)) {
                if (node.kind === "text") {
                    assert.ok(node.typography in DESIGN_SPEC.typographies, `unknown typography in ${spec.name}`);
                    assert.ok(node.color in DESIGN_SPEC.palette, `unknown colour in ${spec.name}`);
                }
            }
        }
    });
});

/** Every text node of the spec with a weight override, from components and screens. */
const WEIGHT_OVERRIDES: readonly string[] = [
    ...COMPONENTS.flatMap((spec) => allNodes(spec.root)),
    ...SCREENS.flatMap((screen) => screen.body.flatMap((node) => allNodes(node))),
].flatMap((node) => (node.kind === "text" && node.fontWeight !== undefined ? [node.fontWeight] : []));

/** The twelve built-in Source Sans Pro variant ids of Penpot, from common/src/app/common/fonts.cljs. */
const BUILT_IN_VARIANT_IDS: ReadonlySet<string> = new Set([
    "200",
    "200italic",
    "300",
    "300italic",
    "regular",
    "italic",
    "600",
    "600italic",
    "bold",
    "bolditalic",
    "black",
    "blackitalic",
]);

/** Expected upright variant id of each weight that the spec uses. */
const EXPECTED_UPRIGHT: Readonly<Record<string, string>> = { "400": "regular", "600": "600", "700": "bold" };

describe("DesignSpec font variants", () => {
    it("maps the upright 400 weight to regular", () => {
        assert.equal(fontVariantIdOf("400"), "regular");
    });

    it("maps each other upright weight to its Penpot variant id", () => {
        assert.equal(fontVariantIdOf("200"), "200");
        assert.equal(fontVariantIdOf("300"), "300");
        assert.equal(fontVariantIdOf("600"), "600");
        assert.equal(fontVariantIdOf("700"), "bold");
        assert.equal(fontVariantIdOf("900"), "black");
    });

    it("appends italic to the id of an italic face", () => {
        assert.equal(fontVariantIdOf("400", true), "italic");
        assert.equal(fontVariantIdOf("200", true), "200italic");
        assert.equal(fontVariantIdOf("300", true), "300italic");
        assert.equal(fontVariantIdOf("600", true), "600italic");
        assert.equal(fontVariantIdOf("700", true), "bolditalic");
        assert.equal(fontVariantIdOf("900", true), "blackitalic");
        assert.equal(fontVariantIdOf("600", false), "600");
    });

    it("throws on a weight that is not a digit string", () => {
        assert.throws(() => fontVariantIdOf("abc"), Error);
        assert.throws(() => fontVariantIdOf("bold"), Error);
        assert.throws(() => fontVariantIdOf(""), Error);
    });

    it("throws on a digit weight that Penpot has no face of, and names it with the supported weights", () => {
        for (const weight of ["100", "500", "800"]) {
            assert.throws(
                () => fontVariantIdOf(weight),
                (error: Error) =>
                    error.message.includes(weight) &&
                    error.message.includes("supported weights: 200, 300, 400, 600, 700, 900"),
                weight
            );
        }
    });

    it("gives every typography an id of the twelve built-in variants, for its own weight", () => {
        for (const [name, style] of Object.entries(TYPOGRAPHIES)) {
            const id = fontVariantIdOf(style.fontWeight);
            assert.ok(BUILT_IN_VARIANT_IDS.has(id), `typography ${name} maps to ${id}`);
            assert.equal(id, EXPECTED_UPRIGHT[style.fontWeight], `typography ${name}`);
        }
    });

    it("gives every text weight override an id of the twelve built-in variants, for its own weight", () => {
        assert.ok(WEIGHT_OVERRIDES.length > 0, "the spec has no weight override to check");
        for (const weight of WEIGHT_OVERRIDES) {
            const id = fontVariantIdOf(weight);
            assert.ok(BUILT_IN_VARIANT_IDS.has(id), `weight override ${weight} maps to ${id}`);
            assert.equal(id, EXPECTED_UPRIGHT[weight], `weight override ${weight}`);
        }
    });

    it("keeps the variant out of the font of the spec", () => {
        assert.equal("fontVariantId" in DESIGN_SPEC.font, false);
    });
});
