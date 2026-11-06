import assert from "node:assert/strict";
import { test } from "node:test";
import { ExporterError, HttpExporterClient, type ExportShapeRequest } from "./ExporterClient";
import { Transit } from "./Transit";

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
