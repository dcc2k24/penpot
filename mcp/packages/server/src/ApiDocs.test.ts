import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ApiDocs, type ApiType } from "./ApiDocs";

/** Collapses every run of whitespace to one space, so that line wrapping does not matter. */
function collapse(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** The paragraphs of a topic: its overview and the text of each member, one entry per blank-line block. */
function topicParagraphs(topic: ApiType): string[] {
    const blocks = [topic.getOverviewText()];
    for (const name of topic.getMemberNames()) {
        blocks.push(topic.getMember(name) ?? "");
    }
    return blocks
        .flatMap((block) => block.split(/\n\s*\n/))
        .map(collapse)
        .filter((paragraph) => paragraph.length > 0);
}

test("the Geometry topic is found by name in any letter case", () => {
    const docs = new ApiDocs();
    for (const name of ["Geometry", "geometry", "GEOMETRY"]) {
        const topic = docs.getTopic(name);
        assert.ok(topic, `${name} is a topic`);
        assert.equal(topic.getName(), "Geometry");
    }
    assert.ok(docs.getTopicNames().includes("Geometry"));
});

test("the Geometry topic has the members the instructions describe", () => {
    const topic = new ApiDocs().getTopic("Geometry");
    assert.ok(topic);
    assert.deepEqual(topic.getMemberNames(), [
        "box",
        "transform",
        "text",
        "gradients",
        "strokes",
        "children",
        "generator",
        "more",
    ]);
});

test("an API type lookup is unchanged and topics are not API types", () => {
    const docs = new ApiDocs();
    assert.equal(docs.getType("board")?.getName(), "Board");
    assert.equal(docs.getType("BOARD")?.getName(), "Board");
    assert.equal(docs.getType("Geometry"), null);
    assert.equal(docs.getTopic("Board"), null);
});

test("member lookup finds an exact name first and then ignores letter case", () => {
    const topic = new ApiDocs().getTopic("Geometry");
    assert.ok(topic);
    assert.equal(topic.getMember("text"), topic.getMember("TEXT"));
    assert.equal(topic.getMember("nope"), null);
});

/** The paragraphs of the "Geometry semantics" section of the instructions, headings left out. */
function sectionParagraphs(markdown: string): { section: string; paragraphs: string[] } {
    const start = markdown.indexOf("## Geometry semantics\n");
    assert.ok(start >= 0, "the instructions have the Geometry semantics section");
    const rest = markdown.slice(start + "## Geometry semantics\n".length);
    const next = rest.search(/^## /m);
    const body = next >= 0 ? rest.slice(0, next) : rest;
    const paragraphs = body
        .split(/\n\s*\n/)
        .filter((block) => !block.trimStart().startsWith("#"))
        .map(collapse)
        .filter((paragraph) => paragraph.length > 0);
    return { section: collapse(markdown.slice(start)), paragraphs };
}

test("the Geometry topic and the instructions section hold the same paragraphs, in both directions", () => {
    const markdown = readFileSync(join(process.cwd(), "data", "backend_instructions.md"), "utf8");
    const { section, paragraphs } = sectionParagraphs(markdown);
    const docs = new ApiDocs();
    const topic = docs.getTopic("Geometry");
    assert.ok(topic);
    const topicTexts = topicParagraphs(topic);
    const topicAll = topicTexts.join(" ");

    assert.ok(paragraphs.length > 0);
    for (const paragraph of paragraphs) {
        assert.ok(
            topicAll.includes(paragraph),
            `section paragraph is in the Geometry topic: ${paragraph.slice(0, 60)}`
        );
    }
    for (const paragraph of topicTexts) {
        assert.ok(section.includes(paragraph), `Geometry topic paragraph is in the section: ${paragraph.slice(0, 60)}`);
    }
});
