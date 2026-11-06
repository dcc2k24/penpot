import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DESIGN_SPEC } from "./DesignSpec.js";
import type { DesignModel } from "./DesignModel.js";
import { PACKAGE_ROOT } from "./Paths.js";
import { DesignVerifier, type CheckResult } from "./Verifier.js";

/** Name of the journey page that holds the onboarding screens. */
const ONBOARDING_PAGE = "Journey: Onboarding";

/** Name of the page that holds the components. */
const COMPONENTS_PAGE = "Components";

/** Writable view of a node of the model, with only the fields that the failing case edits. */
interface EditableNode {
    id: string;
    name: string;
    width: number;
    text: { characters: string } | null;
    children: EditableNode[];
}

/** Writable view of the model, with only the parts that the failing case reads. */
interface EditableModel {
    pages: { name: string; boards: EditableNode[] }[];
    components: { fullName: string; mainInstanceId: string }[];
}

/**
 * Loads the normalised model of the fixture folder.
 */
function loadModel(): DesignModel {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "fixtures", "design.json"), "utf8")) as DesignModel;
}

/**
 * Finds a node by its exact name among the given nodes. Fails the test when no node has the name.
 *
 * @param nodes - nodes to search, not their descendants
 * @param name - exact name of the node
 */
function childNamed(nodes: readonly EditableNode[], name: string): EditableNode {
    const found = nodes.find((node) => node.name === name);
    assert.ok(found, `no node named "${name}"`);
    return found;
}

/**
 * Finds a page by its name in a writable model. Fails the test when the page is missing.
 *
 * @param model - writable view of the model
 * @param name - exact name of the page
 */
function pageNamed(model: EditableModel, name: string): EditableModel["pages"][number] {
    const found = model.pages.find((page) => page.name === name);
    assert.ok(found, `no page named "${name}"`);
    return found;
}

/**
 * Makes a copy of the model with two edits: the headline of the welcome screen gets a new text, and the Stat
 * component gets a new width. The input model is not changed.
 *
 * @param model - the model that passes every check
 */
function editedModel(model: DesignModel): DesignModel {
    const clone: DesignModel = structuredClone(model);
    const editable = clone as EditableModel;

    const onboarding = pageNamed(editable, ONBOARDING_PAGE);
    const welcome = childNamed(onboarding.boards, "Onboarding / Welcome");
    const body = childNamed(welcome.children, "Body");
    const headline = childNamed(body.children, "Headline");
    const headlineText = headline.text;
    assert.ok(headlineText !== null, "headline has no text to edit");
    headlineText.characters = "Welcome to Design Labs";

    const stat = editable.components.find((component) => component.fullName === "Stat");
    assert.ok(stat, "Stat is not in the library");
    const statBoard = pageNamed(editable, COMPONENTS_PAGE).boards.find((board) => board.id === stat.mainInstanceId);
    assert.ok(statBoard, "Stat main board is not on the Components page");
    statBoard.width = 250;

    return clone;
}

/**
 * Describes rows for an assertion message, one row per entry.
 *
 * @param rows - rows of a report
 */
function describeRows(rows: readonly CheckResult[]): string {
    return rows.map((row) => `${row.check} (expected ${row.expected}, actual ${row.actual})`).join("; ");
}

describe("DesignVerifier on the fixture model", () => {
    it("passes every check on the fixture model and reports the five skipped notes", () => {
        const report = new DesignVerifier(DESIGN_SPEC, loadModel()).run();
        const failing = report.results.filter((row) => !row.ok);
        assert.equal(report.failed, 0, `failing checks: ${describeRows(failing)}`);
        assert.equal(report.passed, report.results.length);
        assert.ok(report.results.length > 0, "the verifier ran no checks");
        assert.equal(report.skipped.length, 5);
    });

    it("fails exactly the headline text check and the Stat size check on the edited model", () => {
        const report = new DesignVerifier(DESIGN_SPEC, editedModel(loadModel())).run();
        const failures = report.results.filter((row) => !row.ok);
        assert.equal(failures.length, 2, `failing checks: ${describeRows(failures)}`);

        const headline = failures.find((row) => row.check.includes("Headline") && row.check.includes("characters"));
        assert.ok(headline, `no failing headline check, got: ${describeRows(failures)}`);
        assert.equal(headline.expected, "Welcome to Design Lab");
        assert.equal(headline.actual, "Welcome to Design Labs");

        const stat = failures.find((row) => row.check.includes("Stat") && row.check.includes("size"));
        assert.ok(stat, `no failing Stat size check, got: ${describeRows(failures)}`);
        assert.equal(stat.expected, "240x128");
        assert.equal(stat.actual, "250x128");
    });

    it("formats the report as a table with a status column and a summary line", () => {
        const report = new DesignVerifier(DESIGN_SPEC, loadModel()).run();
        const [header, ...rest] = DesignVerifier.format(report).split("\n");
        assert.ok(header?.includes("check") && header.includes("expected"), `header is: ${header}`);
        assert.ok(header.endsWith("status"), `header does not end with status: ${header}`);

        const summary = rest.find((line) => line.startsWith("checks: "));
        assert.equal(summary, `checks: ${report.results.length}, passed: ${report.passed}, failed: ${report.failed}`);

        const rows = rest.filter((line) => line.includes(" | "));
        assert.equal(rows.length, report.results.length);
        for (const row of rows) {
            const status = row.split(" | ").at(-1);
            assert.ok(status === "ok" || status === "FAIL", `row has no ok or FAIL status: ${row}`);
        }
    });

    it("marks each failing check with FAIL in the formatted report", () => {
        const report = new DesignVerifier(DESIGN_SPEC, editedModel(loadModel())).run();
        const lines = DesignVerifier.format(report).split("\n");
        const failRows = lines.filter((line) => line.endsWith(" | FAIL"));
        assert.equal(failRows.length, 2);
        assert.ok(lines.some((line) => line.startsWith("checks: ") && line.includes(`failed: ${report.failed}`)));
    });
});
