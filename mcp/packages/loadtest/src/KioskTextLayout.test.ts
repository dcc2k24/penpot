import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateRuns, needsPositionData, positionDataChange, type TextShapeLike } from "./KioskTextLayout.js";

const text: TextShapeLike = {
    id: "T",
    x: 100,
    y: 50,
    width: 300,
    height: 34,
    content: {
        type: "root",
        children: [
            {
                type: "paragraph-set",
                children: [
                    {
                        type: "paragraph",
                        children: [
                            {
                                text: "Enter your PIN",
                                fontSize: "28",
                                fontWeight: "700",
                                fontFamily: "sourcesanspro",
                                fills: [{ fillColor: "#101828", fillOpacity: 1 }],
                            },
                        ],
                    },
                ],
            },
        ],
    },
};

test("a text without runs needs them, and one with runs does not", () => {
    assert.equal(needsPositionData(text), true);
    assert.equal(needsPositionData({ ...text, positionData: [] }), true);
    assert.equal(needsPositionData({ ...text, positionData: [{}] }), false);
});

test("an estimated run sits at the box, bottoms out one line down, and is no wider than the box", () => {
    const [run] = estimateRuns(text);
    assert.equal(run.x, 100);
    assert.equal(run.height, 33.6);
    assert.equal(run.y, 50 + 33.6);
    assert.equal(run.width, 215.6);
    assert.equal(run["font-size"], "28px");
    assert.equal(run["font-weight"], "700");
    assert.equal(run.text, "Enter your PIN");
    assert.deepEqual(run.fills, [{ "fill-color": "#101828", "fill-opacity": 1 }]);
    const narrow = estimateRuns({ ...text, width: 40 })[0];
    assert.equal(narrow.width, 40);
});

test("the raw change assigns the runs to position-data", () => {
    const runs = estimateRuns(text);
    assert.deepEqual(positionDataChange("S", "P", runs), {
        type: "mod-obj",
        id: "S",
        pageId: "P",
        operations: [{ type: "assign", value: { "position-data": runs } }],
    });
});

test("a text with no content has no runs", () => {
    assert.deepEqual(estimateRuns({ ...text, content: undefined }), []);
});
