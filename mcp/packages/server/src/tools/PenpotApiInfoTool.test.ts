import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiDocs } from "../ApiDocs";
import type { PenpotMcpServer } from "../PenpotMcpServer";
import type { ToolResponse } from "../ToolResponse";
import { PenpotApiInfoTool } from "./PenpotApiInfoTool";

/** A server stub: the tool reads no session and no backend. */
function serverStub(): PenpotMcpServer {
    return { getSessionContext: () => undefined } as unknown as PenpotMcpServer;
}

/** Builds the tool on the real data files. */
function toolFor(docs: ApiDocs = new ApiDocs()): PenpotApiInfoTool {
    return new PenpotApiInfoTool(serverStub(), docs);
}

/** The text of a response. */
function textOf(response: ToolResponse): string {
    return (response.content[0] as { text: string }).text;
}

/** Whether a response reports a failure. */
function failed(response: ToolResponse): boolean {
    return (response as { isError?: boolean }).isError === true;
}

test("a topic is returned by name in any letter case, as its overview and member list", async () => {
    for (const type of ["Geometry", "geometry", "GEOMETRY"]) {
        const response = await toolFor().execute({ type });
        assert.equal(failed(response), false, `${type} succeeds`);
        const text = textOf(response);
        assert.match(text, /These rules say what the numbers of a shape mean/);
        assert.match(text, /Members: box, transform, text, gradients, strokes, children, generator, more/);
        assert.doesNotMatch(text, /positionData/, "the member details are not in the overview");
    }
});

test("a member of a topic returns its part", async () => {
    const docs = new ApiDocs();
    const expected = docs.getTopic("Geometry")?.getMember("text");
    assert.ok(expected);
    const response = await toolFor(docs).execute({ type: "Geometry", member: "text" });
    assert.equal(failed(response), false);
    assert.equal(textOf(response), expected);
    assert.match(textOf(response), /positionData/);
});

test("a member name of a topic ignores letter case", async () => {
    const docs = new ApiDocs();
    const expected = docs.getTopic("Geometry")?.getMember("gradients");
    const response = await toolFor(docs).execute({ type: "geometry", member: "GRADIENTS" });
    assert.equal(textOf(response), expected);
});

test("an unknown member of a topic lists the valid members", async () => {
    const response = await toolFor().execute({ type: "Geometry", member: "nope" });
    assert.equal(failed(response), true);
    assert.match(textOf(response), /Member "nope" not found in type "Geometry"/);
    assert.match(
        textOf(response),
        /Valid members: box, transform, text, gradients, strokes, children, generator, more\./
    );
});

test("an unknown name lists the topics and the API types", async () => {
    const response = await toolFor().execute({ type: "NoSuchThing" });
    assert.equal(failed(response), true);
    assert.match(textOf(response), /Valid names are the topics \(Geometry\)/);
    assert.match(textOf(response), /API types \(.*\bBoard\b.*\)/);
});

test("an API type lookup still works, with and without a member", async () => {
    const docs = new ApiDocs();
    const board = docs.getType("Board");
    assert.ok(board);
    const whole = await toolFor(docs).execute({ type: "Board" });
    assert.equal(failed(whole), false);
    assert.match(textOf(whole), /Board/);
    const member = board.getMemberNames()[0];
    const part = await toolFor(docs).execute({ type: "Board", member });
    assert.equal(textOf(part), board.getMember(member));
});

test("an unknown member of an API type lists its valid members", async () => {
    const response = await toolFor().execute({ type: "Board", member: "noSuchMember" });
    assert.equal(failed(response), true);
    assert.match(textOf(response), /Valid members: /);
});
