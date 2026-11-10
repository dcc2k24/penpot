import assert from "node:assert/strict";
import { test } from "node:test";
import {
    BATCH_REFUSAL_MS,
    BatchRefusals,
    ExportBatchError,
    ExporterError,
    ExportTooLargeError,
    HttpExporterClient,
    type ExportShapeRequest,
} from "./ExporterClient";
import { Transit } from "./Transit";
import { ZipReader } from "../utils/ZipReader";
import { CallContext } from "./CallContext";

const EXPORTER = "http://exporter.example/";
const BACKEND = "http://backend.example/";
const RENDER_TOKEN = "rs-1";
const PROFILE = "1b2c3d4e-0000-4000-8000-0000000000c1";
const FILE = "1b2c3d4e-0000-4000-8000-0000000000d1";
const PAGE = "1b2c3d4e-0000-4000-8000-0000000000e1";
const OBJECT = "1b2c3d4e-0000-4000-8000-0000000000f1";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const ASSET = "1b2c3d4e-0000-4000-8000-0000000000bb";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10]);
const REQUEST: ExportShapeRequest = {
    fileId: FILE,
    pageId: PAGE,
    objectId: OBJECT,
    format: "png",
    scale: 2,
    profileId: PROFILE,
    name: "shape-1",
};

/** One call seen by the fake fetch. */
interface Call {
    url: string;
    init: RequestInit;
}

/** Answers one call seen by the fake fetch. */
type Route = (call: Call) => Response;

/** Body of an export request, decoded from transit. */
interface ExportBody {
    cmd: string;
    "profile-id": string;
    wait: boolean;
    "is-wasm": boolean;
    exports: ExportEntry[];
}

/** One entry of the exports list of an export request. */
interface ExportEntry {
    "file-id": string;
    "page-id": string;
    "object-id": string;
    type: string;
    suffix: string;
    scale: number;
    name: string;
}

/**
 * Builds a fake fetch that records every call and answers it through a route.
 *
 * @param route - answers each call
 * @returns the fake fetch and the list of recorded calls
 */
function recordingFetch(route: Route): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const call: Call = { url: String(input), init: init ?? {} };
        calls.push(call);
        return route(call);
    };
    return { fetchImpl: fetchImpl as typeof fetch, calls };
}

/**
 * Builds a client whose fetch answers through a route.
 *
 * @param route - answers each call
 * @returns the client and the recorded calls
 */
function clientOn(route: Route): { client: HttpExporterClient; calls: Call[] } {
    const { fetchImpl, calls } = recordingFetch(route);
    return { client: new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl), calls };
}

/**
 * Builds a transit export answer that names an asset in the backend.
 *
 * @param mtype - media type of the resource
 * @returns the transit text
 */
function exportAnswer(mtype: string = "image/png"): string {
    return JSON.stringify([
        "^ ",
        "~:id",
        "~u1b2c3d4e-0000-4000-8000-0000000000aa",
        "~:mtype",
        mtype,
        "~:name",
        "export",
        "~:uri",
        `${BACKEND}assets/by-id/${ASSET}`,
    ]);
}

/**
 * Decodes the body of an export call.
 *
 * @param call - the recorded export call
 * @returns the decoded export body
 */
function exportBodyOf(call: Call): ExportBody {
    return Transit.decode(String(call.init.body)) as ExportBody;
}

/** Answers the export call with a valid answer and the download call with the PNG bytes. */
function exporterRoute(call: Call): Response {
    if (call.init.method === "POST") {
        return new Response(exportAnswer(), {
            status: 200,
            headers: { "content-type": "application/transit+json" },
        });
    }
    return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
}

test("exportShape posts the transit export request to the exporter URI with the render session cookie", async () => {
    const { client, calls } = clientOn(exporterRoute);
    await client.exportShape(RENDER_TOKEN, REQUEST);
    const post = calls[0];
    assert.equal(post.url, EXPORTER);
    assert.equal(post.init.method, "POST");
    const headers = new Headers(post.init.headers);
    assert.equal(headers.get("content-type"), "application/transit+json");
    assert.equal(headers.get("cookie"), "auth-token=rs-1");
    const body = exportBodyOf(post);
    assert.equal(body.cmd, "export-shapes");
    assert.equal(body.wait, true);
    assert.equal(body["is-wasm"], false);
    assert.equal(body["profile-id"], PROFILE);
    assert.equal(body.exports.length, 1);
    const entry = body.exports[0];
    assert.equal(entry["file-id"], FILE);
    assert.equal(entry["page-id"], PAGE);
    assert.equal(entry["object-id"], OBJECT);
    assert.equal(entry.type, "png");
    assert.equal(entry.suffix, "");
    assert.equal(entry.scale, 2);
    assert.equal(entry.name, "shape-1");
});

test("exportShape sends the zero object identifier as is for a page export", async () => {
    const { client, calls } = clientOn(exporterRoute);
    await client.exportShape(RENDER_TOKEN, { ...REQUEST, objectId: ZERO_UUID });
    assert.equal(exportBodyOf(calls[0]).exports[0]["object-id"], ZERO_UUID);
});

test("exportShape downloads the asset named by the answer and returns its bytes", async () => {
    const { client, calls } = clientOn(exporterRoute);
    const rendered = await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `${BACKEND}assets/by-id/${ASSET}`);
    assert.equal(calls[1].init.method, "GET");
    assert.equal(new Headers(calls[1].init.headers).get("cookie"), "auth-token=rs-1");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
    assert.equal(rendered.mimeType, "image/png");
});

test("downloadAsset gets the asset from the backend with the cookie and returns its bytes and content type", async () => {
    const { client, calls } = clientOn(
        () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/webp" } })
    );
    const rendered = await client.downloadAsset(RENDER_TOKEN, ASSET);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BACKEND}assets/by-id/${ASSET}`);
    assert.equal(new Headers(calls[0].init.headers).get("cookie"), "auth-token=rs-1");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
    assert.equal(rendered.mimeType, "image/webp");
});

test("downloadAsset keeps the path prefix of the backend URI", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(PNG_BYTES, { status: 200 }));
    const client = new HttpExporterClient(EXPORTER, "http://host.example/penpot", 120, fetchImpl);
    await client.downloadAsset(RENDER_TOKEN, ASSET);
    assert.equal(calls[0].url, `http://host.example/penpot/assets/by-id/${ASSET}`);
});

test("downloadAsset reports application/octet-stream when the backend sends no content type", async () => {
    const { client } = clientOn(() => new Response(PNG_BYTES, { status: 200 }));
    const rendered = await client.downloadAsset(RENDER_TOKEN, ASSET);
    assert.equal(rendered.mimeType, "application/octet-stream");
});

test("exportShape takes the resource media type when the download reports application/octet-stream", async () => {
    const { client } = clientOn((call) => {
        if (call.init.method === "POST") {
            return new Response(exportAnswer("image/svg+xml"), { status: 200 });
        }
        return new Response(PNG_BYTES, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
        });
    });
    const rendered = await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(rendered.mimeType, "image/svg+xml");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
});

test("exportShape throws when the export answer has no asset uri", async () => {
    const { client, calls } = clientOn(
        () =>
            new Response(
                JSON.stringify(["^ ", "~:id", "~u1b2c3d4e-0000-4000-8000-0000000000aa", "~:mtype", "image/png"]),
                { status: 200 }
            )
    );
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), /the exporter answer has no asset uri/);
    assert.equal(calls.length, 1);
});

test("exportShape maps a 401 to an ExporterError that names the render session", async () => {
    const { client } = clientOn(() => new Response("", { status: 401 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 401);
        assert.match(error.message, /render session/);
        return true;
    });
});

test("exportShape maps a 429 to an ExporterError that says the exporter is busy", async () => {
    const { client } = clientOn(() => new Response("", { status: 429 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 429);
        assert.match(error.message, /busy/);
        return true;
    });
});

test("exportShape maps a 500 with a transit body to an ExporterError that carries the hint", async () => {
    const body = JSON.stringify(["^ ", "~:type", "~:server-error", "~:code", "~:internal", "~:hint", "boom"]);
    const { client } = clientOn(() => new Response(body, { status: 500 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 500);
        assert.equal(error.message, "The exporter failed to render the shape: boom");
        return true;
    });
});

test("exportShape maps a 500 with a non-transit body without decoding it or echoing it", async () => {
    const { client } = clientOn(() => new Response("<html>oops</html>", { status: 500 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 500);
        assert.equal(error.message, "The exporter failed to render the shape: no details were returned");
        assert.ok(!error.message.includes("<html>"));
        return true;
    });
});

test("exportShape reports a rejected fetch as a missing exporter response", async () => {
    const fetchImpl = (async () => {
        throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl);
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), /did not respond \(TypeError\)/);
});

test("downloadAsset refuses an identifier that is not a UUID before any fetch", async () => {
    const { client, calls } = clientOn(exporterRoute);
    await assert.rejects(client.downloadAsset(RENDER_TOKEN, "../../admin"), /must be a UUID/);
    assert.equal(calls.length, 0);
});

test("downloadAsset maps the backend refusal and missing asset to ExporterError", async () => {
    const forbidden = clientOn(() => new Response("", { status: 403 }));
    await assert.rejects(forbidden.client.downloadAsset(RENDER_TOKEN, ASSET), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 401);
        assert.match(error.message, /render session cannot read/);
        return true;
    });
    const missing = clientOn(() => new Response("", { status: 404 }));
    await assert.rejects(missing.client.downloadAsset(RENDER_TOKEN, ASSET), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 404);
        assert.match(error.message, /not found/);
        return true;
    });
});

/** Verbose transit answer of the exporter, as captured from a real render. */
const VERBOSE_ANSWER =
    '{"~:mtype":"image/png","~:name":"export","~:filename":"export.png","~:id":"~ub7a8c5da-5765-8008-8008-e4e12150945d","~:uri":{"~#uri":"http://localhost:9002/assets/by-id/8559e494-c794-4f89-bbcc-b9847ce9af00"}}';
/** The same answer in non-verbose transit JSON. */
const NON_VERBOSE_ANSWER =
    '["^ ","~:mtype","image/png","~:name","export","~:filename","export.png","~:id","~ub7a8c5da-5765-8008-8008-e4e12150945d","~:uri",["~#uri","http://localhost:9002/assets/by-id/8559e494-c794-4f89-bbcc-b9847ce9af00"]]';
/** Asset identifier named by both answers above. */
const ANSWER_ASSET = "8559e494-c794-4f89-bbcc-b9847ce9af00";
/** Origin of the public URI named by the answers above, which the asset downloads use by default. */
const PUBLIC = "http://localhost:9002/";

/**
 * Builds a route that answers the export call with a transit answer and the download with PNG bytes.
 *
 * @param answer - the transit text of the export answer
 * @returns the route
 */
function answerRoute(answer: string): Route {
    return (call) => {
        if (call.init.method === "POST") {
            return new Response(answer, { status: 200, headers: { "content-type": "application/transit+json" } });
        }
        return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    };
}

test("exportShape downloads the asset named by a verbose transit answer", async () => {
    const { client, calls } = clientOn(answerRoute(VERBOSE_ANSWER));
    const rendered = await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `${PUBLIC}assets/by-id/${ANSWER_ASSET}`);
    assert.equal(new Headers(calls[1].init.headers).get("cookie"), "auth-token=rs-1");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
    assert.equal(rendered.mimeType, "image/png");
});

test("exportShape downloads the asset named by a non-verbose transit answer", async () => {
    const { client, calls } = clientOn(answerRoute(NON_VERBOSE_ANSWER));
    const rendered = await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, `${PUBLIC}assets/by-id/${ANSWER_ASSET}`);
    assert.equal(new Headers(calls[1].init.headers).get("cookie"), "auth-token=rs-1");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
    assert.equal(rendered.mimeType, "image/png");
});

test("exportShape names the HTTP status and the first 200 characters of a failed asset download", async () => {
    const body = `${"a".repeat(200)}${"Z".repeat(20)}`;
    const { client } = clientOn((call) => {
        if (call.init.method === "POST") {
            return new Response(exportAnswer(), {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        return new Response(body, { status: 500 });
    });
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof ExporterError);
        assert.equal(error.status, 500);
        assert.ok(error.message.includes("500"), error.message);
        assert.ok(error.message.includes(body.slice(0, 200)), error.message);
        assert.ok(!error.message.includes(body.charAt(200)), error.message);
        return true;
    });
});

test("the constructor rejects a malformed exporter URI", () => {
    assert.throws(
        () => new HttpExporterClient("exporter without scheme", BACKEND),
        /PENPOT_MCP_EXPORTER_URI must be an absolute HTTP\(S\) URI\./
    );
});

test("the constructor rejects a backend URI that is not HTTP(S)", () => {
    assert.throws(
        () => new HttpExporterClient(EXPORTER, "ftp://backend.example/"),
        /PENPOT_MCP_BACKEND_URI must be an absolute HTTP\(S\) URI\./
    );
});

test("exportShape treats a 204 answer as a missing file and names the public URI setting", async () => {
    const { client } = clientOn(() => new Response(null, { status: 204 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HTTP 204 No Content/);
        assert.match(error.message, /PENPOT_MCP_ASSETS_URI/);
        assert.match(error.message, /nginx/);
        return true;
    });
});

test("exportShape treats an x-accel-redirect answer as a missing file and names the cause", async () => {
    const { client } = clientOn(
        () => new Response("", { status: 200, headers: { "x-accel-redirect": "/internal/asset" } })
    );
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), /x-accel-redirect header/);
});

test("exportShape treats an empty successful answer as a missing file and names the cause", async () => {
    const { client } = clientOn(() => new Response("", { status: 200 }));
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), /empty body/);
});

test("exportShape asks the exporter not to follow redirects", async () => {
    const { client, calls } = clientOn(answerRoute(NON_VERBOSE_ANSWER));
    await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[1].init.redirect, "manual");
});

test("exportShape refuses an exporter answer over the cap, naming the variable", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("x".repeat(4096), { status: 200 }));
    const capped = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl, 0.001);
    await assert.rejects(capped.exportShape(RENDER_TOKEN, REQUEST), /PENPOT_MCP_BACKEND_MAX_RESPONSE_MB/);
});

test("downloadAsset refuses an asset over the cap while it streams", async () => {
    const { fetchImpl } = recordingFetch(
        () => new Response(new Uint8Array(4096), { status: 200, headers: { "content-type": "image/png" } })
    );
    const capped = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl, 0.001);
    await assert.rejects(capped.downloadAsset(RENDER_TOKEN, ANSWER_ASSET), /PENPOT_MCP_BACKEND_MAX_RESPONSE_MB/);
});

test("asset downloads use the origin of the absolute uri that the exporter answers with", async () => {
    const { client, calls } = clientOn(answerRoute(VERBOSE_ANSWER));
    await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls[1].url, `http://localhost:9002/assets/by-id/${ANSWER_ASSET}`);
    assert.equal(new Headers(calls[1].init.headers).get("cookie"), "auth-token=rs-1");
});

test("PENPOT_MCP_ASSETS_URI wins over the origin of the exporter answer", async () => {
    const { fetchImpl, calls } = recordingFetch(answerRoute(VERBOSE_ANSWER));
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl, 64, "https://cdn.example/penpot");
    await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls[1].url, `https://cdn.example/penpot/assets/by-id/${ANSWER_ASSET}`);
    assert.equal(new Headers(calls[1].init.headers).get("cookie"), "auth-token=rs-1");
});

test("an answer without an absolute uri falls back to PENPOT_MCP_BACKEND_URI", async () => {
    const relative = JSON.stringify(["^ ", "~:mtype", "image/png", "~:uri", `/assets/by-id/${ANSWER_ASSET}`]);
    const { client, calls } = clientOn(answerRoute(relative));
    await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls[1].url, `${BACKEND}assets/by-id/${ANSWER_ASSET}`);
});

test("a fill download without an exporter answer uses PENPOT_MCP_ASSETS_URI, or the backend URI", async () => {
    const withAssets = recordingFetch(
        () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } })
    );
    await new HttpExporterClient(
        EXPORTER,
        BACKEND,
        120,
        withAssets.fetchImpl,
        64,
        "https://cdn.example/penpot/"
    ).downloadAsset(RENDER_TOKEN, ANSWER_ASSET);
    assert.equal(withAssets.calls[0].url, `https://cdn.example/penpot/assets/by-id/${ANSWER_ASSET}`);

    const plain = recordingFetch(
        () => new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } })
    );
    await new HttpExporterClient(EXPORTER, BACKEND, 120, plain.fetchImpl).downloadAsset(RENDER_TOKEN, ANSWER_ASSET);
    assert.equal(plain.calls[0].url, `${BACKEND}assets/by-id/${ANSWER_ASSET}`);
});

test("an asset redirect to the same origin is followed once, with the cookie", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
        if (call.init.method === "POST") {
            return new Response(VERBOSE_ANSWER, {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        if (call.url.endsWith("/redirected/asset")) {
            return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
        }
        return new Response(null, { status: 302, headers: { location: "/redirected/asset" } });
    });
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl);
    const rendered = await client.exportShape(RENDER_TOKEN, REQUEST);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].url, "http://localhost:9002/redirected/asset");
    assert.equal(new Headers(calls[2].init.headers).get("cookie"), "auth-token=rs-1");
    assert.equal(calls[2].init.redirect, "manual");
    assert.deepEqual(rendered.bytes, PNG_BYTES);
});

test("an asset redirect to another origin is refused, and the cookie is not sent there", async () => {
    const { fetchImpl, calls } = recordingFetch((call) => {
        if (call.init.method === "POST") {
            return new Response(VERBOSE_ANSWER, {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        return new Response(null, { status: 302, headers: { location: "http://elsewhere.example/x" } });
    });
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl);
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), /another origin \(http:\/\/elsewhere\.example\)/);
    assert.equal(calls.length, 2);
});

test("an asset answered with 204 names PENPOT_MCP_ASSETS_URI", async () => {
    const { client } = clientOn((call) => {
        if (call.init.method === "POST") {
            return new Response(VERBOSE_ANSWER, {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        return new Response(null, { status: 204 });
    });
    await assert.rejects(client.exportShape(RENDER_TOKEN, REQUEST), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /asset download answered without a file \(HTTP 204 No Content\)/);
        assert.match(error.message, /PENPOT_MCP_ASSETS_URI/);
        return true;
    });
});

test("every exporter and backend call goes through the connection pool", async () => {
    const pool = { pool: true };
    const { fetchImpl, calls } = recordingFetch(() => new Response(PNG_BYTES, { status: 200 }));
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl, 64, undefined, pool as never);
    await client.downloadAsset(RENDER_TOKEN, ASSET);
    assert.equal(calls.length, 1);
    assert.equal((calls[0].init as { dispatcher?: unknown }).dispatcher, pool);
});

test("a failed answer quotes at most 200 characters, and the rest of a large body is not read", async () => {
    const huge = "e".repeat(5 * 1024 * 1024);
    const { client } = clientOn(() => new Response(huge, { status: 500 }));
    const error = await client.downloadAsset(RENDER_TOKEN, ASSET).catch((caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 400, `message is ${error.message.length} characters`);
    assert.match(error.message, /HTTP 500/);
});

/** A fetch that never answers, and rejects when its signal fires. It records the signal of each call. */
function hangingFetch(seen: AbortSignal[]): typeof fetch {
    return ((_input: unknown, init?: RequestInit) => {
        const signal = init?.signal ?? undefined;
        if (signal !== undefined) {
            seen.push(signal);
        }
        return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("aborted by the signal")));
        });
    }) as unknown as typeof fetch;
}

test("an exporter render stops at once when the call of the tool is abandoned", async () => {
    const seen: AbortSignal[] = [];
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, hangingFetch(seen));
    const controller = new AbortController();
    const call = CallContext.run({ requestId: "req-1", signal: controller.signal }, () =>
        client.exportShape(RENDER_TOKEN, REQUEST)
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(call);
    assert.equal(seen[0].aborted, true);
});

test("an asset download stops at once when the call of the tool is abandoned", async () => {
    const seen: AbortSignal[] = [];
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, hangingFetch(seen));
    const controller = new AbortController();
    const call = CallContext.run({ requestId: "req-2", signal: controller.signal }, () =>
        client.downloadAsset(RENDER_TOKEN, ASSET)
    );
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(call);
    assert.equal(seen[0].aborted, true);
});

/** Builds a stored (method 0) ZIP archive of the given entries, as the exporter answers a batch. */
function storedZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const data = Buffer.from(entry.data);
        const crc = ZipReader.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        const body = Buffer.concat([local, name, data]);
        locals.push(body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, name]));
        offset += body.length;
    }
    const centralBytes = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

/** Shape ids of the batch tests. */
const SHAPE_A = "1b2c3d4e-0000-4000-8000-0000000000a1";
const SHAPE_B = "1b2c3d4e-0000-4000-8000-0000000000a2";
const SHAPE_C = "1b2c3d4e-0000-4000-8000-0000000000a3";

/**
 * Builds the export request of one shape of the batch tests, named by the shape id as a batch names it.
 *
 * @param id - the shape id
 */
function requestFor(id: string): ExportShapeRequest {
    return { ...REQUEST, objectId: id, name: id };
}

/**
 * Builds a route that answers the batch export call with a transit answer that names a ZIP, and the download of that
 * ZIP with the given bytes.
 *
 * @param zip - the bytes of the ZIP that the download returns
 * @returns the route
 */
function batchRoute(zip: Uint8Array): Route {
    return (call) => {
        if (call.init.method === "POST") {
            return new Response(exportAnswer("application/zip"), {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        return new Response(zip, { status: 200, headers: { "content-type": "application/zip" } });
    };
}

test("exportShapes sends every shape in one request, each named by its shape id, with is-wasm from the renderer", async () => {
    const zip = storedZip([
        { name: `${SHAPE_A}.png`, data: PNG_BYTES },
        { name: `${SHAPE_B}.png`, data: PNG_BYTES },
        { name: `${SHAPE_C}.png`, data: PNG_BYTES },
    ]);
    const { client, calls } = clientOn(batchRoute(zip));
    const requests = [requestFor(SHAPE_A), requestFor(SHAPE_B), requestFor(SHAPE_C)];
    await client.exportShapes(RENDER_TOKEN, requests, { renderer: "wasm" });
    const body = exportBodyOf(calls[0]);
    assert.equal(body.cmd, "export-shapes");
    assert.equal(body["is-wasm"], true);
    assert.deepEqual(
        body.exports.map((entry) => entry.name),
        [SHAPE_A, SHAPE_B, SHAPE_C]
    );
    assert.deepEqual(
        body.exports.map((entry) => entry["object-id"]),
        [SHAPE_A, SHAPE_B, SHAPE_C]
    );
    await client.exportShapes(RENDER_TOKEN, requests);
    assert.equal(exportBodyOf(calls[2])["is-wasm"], false, "the browser renderer is the default");
});

test("exportShapes maps the entries of the ZIP back to the shape ids and gives each file its bytes", async () => {
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([4, 5, 6, 7]);
    const zip = storedZip([
        { name: `${SHAPE_B}.png`, data: bytesB },
        { name: `${SHAPE_A}.png`, data: bytesA },
    ]);
    const { client } = clientOn(batchRoute(zip));
    const files = await client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]);
    assert.deepEqual(Buffer.from(files.get(SHAPE_A)?.bytes ?? []), Buffer.from(bytesA));
    assert.deepEqual(Buffer.from(files.get(SHAPE_B)?.bytes ?? []), Buffer.from(bytesB));
    assert.equal(files.get(SHAPE_A)?.mimeType, "image/png");
    assert.equal(files.size, 2);
});

test("exportShapes fails the whole chunk with ExportBatchError when an entry names no requested shape", async () => {
    const zip = storedZip([
        { name: `${SHAPE_A}.png`, data: PNG_BYTES },
        { name: "stranger.png", data: PNG_BYTES },
    ]);
    const { client } = clientOn(batchRoute(zip));
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExportBatchError && /stranger\.png/.test(error.message)
    );
});

test("exportShapes fails the whole chunk with ExportBatchError when a requested shape has no entry", async () => {
    const zip = storedZip([{ name: `${SHAPE_A}.png`, data: PNG_BYTES }]);
    const { client } = clientOn(batchRoute(zip));
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExportBatchError && error.message.includes(SHAPE_B)
    );
});

test("exportShapes fails the chunk with ExportBatchError when the answer is not a readable ZIP", async () => {
    const { client } = clientOn(batchRoute(new Uint8Array([80, 75, 1, 2, 3])));
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExportBatchError
    );
});

test("exportShapes with one request posts a plain file, keyed by the request name", async () => {
    const { client, calls } = clientOn(exporterRoute);
    const files = await client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A)]);
    assert.equal(calls.length, 2, "one export call and one download, with no ZIP");
    assert.equal(exportBodyOf(calls[0]).exports.length, 1);
    assert.deepEqual(files.get(SHAPE_A)?.bytes, PNG_BYTES);
});

test("exportShape passes the renderer to the request", async () => {
    const { client, calls } = clientOn(exporterRoute);
    await client.exportShape(RENDER_TOKEN, REQUEST, { renderer: "wasm" });
    assert.equal(exportBodyOf(calls[0])["is-wasm"], true);
});

test("a refusal of batches lasts ten minutes for one exporter, and only that exporter", () => {
    const exporter = {};
    const other = {};
    BatchRefusals.refuse(exporter, 1_000);
    assert.equal(BatchRefusals.refusesBatches(exporter, 1_000), true);
    assert.equal(BatchRefusals.refusesBatches(exporter, 1_000 + BATCH_REFUSAL_MS - 1), true);
    assert.equal(BatchRefusals.refusesBatches(exporter, 1_000 + BATCH_REFUSAL_MS), false);
    assert.equal(BatchRefusals.refusesBatches(other, 1_000), false);
    BatchRefusals.refuse(exporter, 5_000);
    BatchRefusals.forget(exporter);
    assert.equal(BatchRefusals.refusesBatches(exporter, 5_000), false);
});

test("a batch of ten 1 MB boards is read within its own cap, not the cap of one file", async () => {
    const data = new Uint8Array(1024 * 1024).fill(3);
    const ids = Array.from(
        { length: 10 },
        (_, index) => `1b2c3d4e-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`
    );
    const zip = storedZip(ids.map((id) => ({ name: `${id}.png`, data })));
    const { client } = clientOn(batchRoute(zip));
    const files = await client.exportShapes(RENDER_TOKEN, ids.map(requestFor));
    assert.equal(files.size, 10);
});

test("a batch answer over its cap is an ExportTooLargeError, which is not a refusal of batches", async () => {
    const data = new Uint8Array(2 * 1024 * 1024).fill(4);
    const zip = storedZip([
        { name: `${SHAPE_A}.png`, data },
        { name: `${SHAPE_B}.png`, data },
    ]);
    const { fetchImpl } = recordingFetch(batchRoute(zip));
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl, 1);
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExportTooLargeError
    );
});

test("an entry whose extension is not the one of its format names no shape", async () => {
    const zip = storedZip([
        { name: `${SHAPE_A}.exe`, data: PNG_BYTES },
        { name: `${SHAPE_B}.png`, data: PNG_BYTES },
    ]);
    const { client } = clientOn(batchRoute(zip));
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExportBatchError
    );
});

test("a failed download of the batch ZIP is an ExporterError from the asset stage", async () => {
    const { fetchImpl } = recordingFetch((call) => {
        if (call.init.method === "POST") {
            return new Response(exportAnswer("application/zip"), {
                status: 200,
                headers: { "content-type": "application/transit+json" },
            });
        }
        return new Response("boom", { status: 503 });
    });
    const client = new HttpExporterClient(EXPORTER, BACKEND, 120, fetchImpl);
    await assert.rejects(
        client.exportShapes(RENDER_TOKEN, [requestFor(SHAPE_A), requestFor(SHAPE_B)]),
        (error: unknown) => error instanceof ExporterError && error.status === 503 && error.source === "asset"
    );
});
