// End-to-end smoke test of the backend-mode MCP tools against a live stack.
// Usage: node scripts/smoke.mjs <mcp-url> <token-file> <vars.json>
import { readFileSync } from "node:fs";
import { McpLoadClient } from "../dist/McpLoadClient.js";

const [url, tokenFile, varsFile] = process.argv.slice(2);
const token = readFileSync(tokenFile, "utf8").trim();
const vars = JSON.parse(readFileSync(varsFile, "utf8"));
const client = new McpLoadClient();
await client.connect(url, token);

let failures = 0;
async function step(name, toolName, args, check) {
    const r = await client.callTool(toolName, args);
    let parsed = r.json;
    if (parsed === undefined && typeof r.text === "string") {
        try {
            parsed = JSON.parse(r.text);
        } catch {
            parsed = undefined;
        }
    }
    let ok = r.ok && !r.isError;
    let note = "";
    if (ok && check) {
        try {
            const res = check(parsed, r);
            if (res === false) {
                ok = false;
                note = "check returned false";
            } else if (typeof res === "string") {
                note = res;
            }
        } catch (e) {
            ok = false;
            note = `check threw: ${e.message}`;
        }
    }
    if (!ok) {
        failures++;
    }
    const text = (r.text ?? "").replace(/\s+/g, " ").slice(0, 160);
    console.log(
        `${ok ? "PASS" : "FAIL"} ${name} (${r.durationMs} ms)${note ? " " + note : ""}${ok ? "" : " :: " + text}`
    );
    return parsed;
}

const fileId = vars.fileId;
const pageId = vars.pageId;

await step("whoami", "whoami", {}, (j) => Array.isArray(j.scopes) && j.scopes.includes("mcp:write"));

const ops = await step(
    "apply_operations create board+rects+text",
    "apply_operations",
    {
        fileId,
        operations: [
            {
                op: "create_board",
                pageId,
                id: "$tmp:board",
                name: "Card",
                x: 100,
                y: 100,
                width: 320,
                height: 200,
                props: { fills: [{ fillColor: "#FFFFFF", fillOpacity: 1 }] },
            },
            {
                op: "create_rect",
                pageId,
                id: "$tmp:r1",
                parentId: "$tmp:board",
                name: "Accent",
                x: 116,
                y: 116,
                width: 64,
                height: 64,
                props: { fills: [{ fillColor: "#3366FF", fillOpacity: 1 }], r1: 8, r2: 8, r3: 8, r4: 8 },
            },
            {
                op: "create_ellipse",
                pageId,
                id: "$tmp:e1",
                parentId: "$tmp:board",
                name: "Dot",
                x: 200,
                y: 116,
                width: 24,
                height: 24,
                props: { fills: [{ fillColor: "#FF3366", fillOpacity: 1 }] },
            },
            {
                op: "create_text",
                pageId,
                id: "$tmp:t1",
                parentId: "$tmp:board",
                name: "Title",
                x: 116,
                y: 200,
                characters: "Hello MCP",
                fontSize: 24,
            },
        ],
    },
    (j) => (typeof j.revn === "number" && j.createdIds && j.createdIds["$tmp:board"] ? `revn=${j.revn}` : false)
);
const boardId = ops?.createdIds?.["$tmp:board"];
const rectId = ops?.createdIds?.["$tmp:r1"];

await step("get_page_tree", "get_page_tree", { fileId, pageId, depth: 3 }, (j) => {
    const names = JSON.stringify(j);
    return names.includes("Card") && names.includes("Accent") ? `root children ok` : false;
});

await step("get_shapes rect", "get_shapes", { fileId, pageId, ids: [rectId] }, (j) => {
    const s = j.shapes?.[0];
    return s && s.width === 64 && s.fills?.[0]?.fillColor === "#3366FF" ? `rect ok x=${s.x}` : false;
});

await step(
    "update_shape move board",
    "apply_operations",
    {
        fileId,
        operations: [{ op: "update_shape", pageId, id: boardId, props: { x: 400, y: 100 } }],
    },
    (j) => ((j.changeTypes?.["mod-obj"] ?? 0) >= 2 ? `mod-obj=${j.changeTypes["mod-obj"]}` : false)
);

await step("get_shapes rect after move", "get_shapes", { fileId, pageId, ids: [rectId] }, (j) => {
    const s = j.shapes?.[0];
    if (!s || s.x !== 416) throw new Error(`rect x=${s?.x}, expected 416: children must follow the board`);
    return `rect followed the board x=${s.x}`;
});

await step(
    "find_shapes by name",
    "find_shapes",
    { fileId, pageId, nameRegex: "^Accent$" },
    (j) => j.matches?.length >= 1
);

await step(
    "batch_create_shapes",
    "batch_create_shapes",
    {
        fileId,
        pageId,
        tree: [
            {
                type: "board",
                name: "List",
                x: 100,
                y: 400,
                width: 300,
                height: 300,
                children: [
                    { type: "rect", name: "Row 1", x: 110, y: 410, width: 280, height: 40 },
                    { type: "rect", name: "Row 2", x: 110, y: 460, width: 280, height: 40 },
                    { type: "text", name: "Label", x: 110, y: 520, width: 200, height: 24, characters: "Rows" },
                ],
            },
        ],
    },
    (j) => {
        const ids = j.result?.createdIds ?? j.createdIds;
        return ids && Object.keys(ids).length >= 4 ? `created ${Object.keys(ids).length}` : false;
    }
);

await step(
    "apply_operations flex layout",
    "apply_operations",
    {
        fileId,
        operations: [
            {
                op: "set_flex_layout",
                pageId,
                id: boardId,
                layoutFlexDir: "column",
                layoutGap: { rowGap: 8, columnGap: 8 },
                layoutPadding: { p1: 16, p2: 16, p3: 16, p4: 16 },
            },
        ],
    },
    (j) => typeof j.revn === "number"
);

await step("get_file_outline", "get_file_outline", { fileId }, (j) =>
    j.pages?.[0]?.shapeCount >= 8 ? `shapes=${j.pages[0].shapeCount}` : false
);

await step(
    "dryRun delete",
    "apply_operations",
    {
        fileId,
        dryRun: true,
        operations: [{ op: "delete_shapes", pageId, ids: [rectId] }],
    },
    (j) => j.dryRun === true && j.validation?.ok === true
);

await step(
    "apply_raw_changes mod-obj",
    "apply_raw_changes",
    {
        fileId,
        changes: [
            { type: "mod-obj", id: rectId, pageId, operations: [{ type: "set", attr: "name", val: "Accent renamed" }] },
        ],
    },
    (j) => typeof j.revn === "number"
);

await step(
    "tokens create set+token",
    "apply_operations",
    {
        fileId,
        operations: [
            { op: "create_token_set", id: "$tmp:set", name: "core", active: true },
            { op: "create_token", setId: "$tmp:set", type: "color", name: "brand.primary", value: "#3366FF" },
            { op: "create_token", setId: "$tmp:set", type: "spacing", name: "space.md", value: "16" },
        ],
    },
    (j) => typeof j.revn === "number"
);

await step("get_tokens", "get_tokens", { fileId }, (j) =>
    (j.tokens?.length ?? 0) >= 2 ? `tokens=${j.tokens.length}` : false
);

await step("get_library", "get_library", { fileId }, (j) => j && "components" in j);

await step(
    "execute_code create+read",
    "execute_code",
    {
        fileId,
        pageId,
        code: `const b = penpot.createBoard(); b.name = "FromScript"; b.resize(200, 120); b.x = 800; b.y = 100;
           const r = penpot.createRectangle(); r.resize(50, 50); b.appendChild(r); r.fills = [{fillColor: "#00AA55", fillOpacity: 1}];
           return { boardId: b.id, width: b.width, children: penpot.currentPage.findShapes().length };`,
    },
    (j) => (j.result?.width === 200 ? `script ok children=${j.result.children}` : false)
);

await step(
    "manage_versions list",
    "manage_versions",
    { fileId, action: "list" },
    (j) => Array.isArray(j) || Array.isArray(j.snapshots) || j
);

await step(
    "comments create thread",
    "comments",
    { fileId, action: "create_thread", pageId, position: { x: 120, y: 120 }, content: "MCP says hi" },
    (j) => j && (j.id || j.threadId)
);

await step("export_shape png", "export_shape", { fileId, pageId, shapeId: boardId, format: "png" }, (j, r) => {
    if (r.text && r.text.trim() !== "") throw new Error(`unexpected text instead of an image: ${r.text.slice(0, 80)}`);
    return "image block returned";
});

await step(
    "import_svg",
    "import_svg",
    {
        fileId,
        pageId,
        x: 600,
        y: 400,
        svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="60" height="40" fill="#ff0000"/><circle cx="80" cy="70" r="15" fill="#0000ff"/></svg>',
    },
    (j) => (j.shapeIds?.length >= 2 ? `shapes=${j.shapeIds.length}` : false)
);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
await client.close?.();
process.exit(failures === 0 ? 0 : 1);
