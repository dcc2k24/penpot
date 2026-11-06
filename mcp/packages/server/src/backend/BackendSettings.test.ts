import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendSettings } from "./BackendSettings";

test("defaults match the documented values", () => {
    const settings = BackendSettings.fromEnvironment({});
    assert.equal(settings.timeoutSeconds, 120);
    assert.equal(settings.rateLimitPerSecond, 10);
    assert.equal(settings.rateLimitBurst, 20);
    assert.equal(settings.allowQueryToken, true);
});

test("reads every setting from the environment", () => {
    const settings = BackendSettings.fromEnvironment({
        PENPOT_MCP_BACKEND_TIMEOUT_S: "30",
        PENPOT_MCP_RATE_LIMIT_RPS: "2.5",
        PENPOT_MCP_RATE_LIMIT_BURST: "5",
        PENPOT_MCP_ALLOW_QUERY_TOKEN: "false",
    });
    assert.equal(settings.timeoutSeconds, 30);
    assert.equal(settings.rateLimitPerSecond, 2.5);
    assert.equal(settings.rateLimitBurst, 5);
    assert.equal(settings.allowQueryToken, false);
});

test("a blank value falls back to the default", () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_RATE_LIMIT_RPS: "  " });
    assert.equal(settings.rateLimitPerSecond, 10);
});

for (const [name, value] of [
    ["PENPOT_MCP_BACKEND_TIMEOUT_S", "soon"],
    ["PENPOT_MCP_BACKEND_TIMEOUT_S", "0"],
    ["PENPOT_MCP_RATE_LIMIT_RPS", "-1"],
    ["PENPOT_MCP_RATE_LIMIT_BURST", "many"],
]) {
    test(`${name}=${value} is a startup error that names the variable`, () => {
        assert.throws(() => BackendSettings.fromEnvironment({ [name]: value }), new RegExp(name));
    });
}

test("PENPOT_MCP_ALLOW_QUERY_TOKEN accepts only true or false", () => {
    assert.throws(
        () => BackendSettings.fromEnvironment({ PENPOT_MCP_ALLOW_QUERY_TOKEN: "yes" }),
        /must be "true" or "false"/
    );
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_ALLOW_QUERY_TOKEN: "TRUE" }).allowQueryToken, true);
});

test("the backend response cap defaults to 64 MB", () => {
    assert.equal(BackendSettings.fromEnvironment({}).maxResponseMb, 64);
    assert.equal(BackendSettings.readMaxResponseMb({}), 64);
});

test("PENPOT_MCP_BACKEND_MAX_RESPONSE_MB sets the backend response cap", () => {
    assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: "8" }), 8);
    assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: " 0.5 " }), 0.5);
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: "16" }).maxResponseMb, 16);
});

for (const value of ["", "   ", "abc", "0", "-3", "Infinity", "NaN"]) {
    test(`PENPOT_MCP_BACKEND_MAX_RESPONSE_MB=${JSON.stringify(value)} falls back to 64 without throwing`, () => {
        assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: value }), 64);
        assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: value }).maxResponseMb, 64);
    });
}

test("the exporter URI defaults to the local exporter", () => {
    assert.equal(BackendSettings.fromEnvironment({}).exporterUri, "http://localhost:6061/");
});

test("PENPOT_MCP_EXPORTER_URI sets the exporter URI", () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORTER_URI: "https://exporter.example:7000/" });
    assert.equal(settings.exporterUri, "https://exporter.example:7000/");
});

test("a blank PENPOT_MCP_EXPORTER_URI falls back to the default", () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORTER_URI: "   " });
    assert.equal(settings.exporterUri, "http://localhost:6061/");
});

for (const [label, value] of [
    ["a malformed value", "not a uri"],
    ["an ftp URI", "ftp://exporter.example/"],
    ["a query string", "http://exporter.example:6061/?token=1"],
    ["credentials", "http://user:pass@exporter.example:6061/"],
]) {
    test(`PENPOT_MCP_EXPORTER_URI with ${label} is a startup error that names the variable`, () => {
        assert.throws(
            () => BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORTER_URI: value }),
            /PENPOT_MCP_EXPORTER_URI must be an HTTP\(S\) URI/
        );
    });
}

test("PENPOT_MCP_ASSETS_URI is optional and must be an HTTP(S) URI without credentials, query or fragment", () => {
    assert.equal(BackendSettings.readAssetsUri({}), undefined);
    assert.equal(BackendSettings.readAssetsUri({ PENPOT_MCP_ASSETS_URI: "   " }), undefined);
    assert.equal(
        BackendSettings.readAssetsUri({ PENPOT_MCP_ASSETS_URI: " https://cdn.example/penpot/ " }),
        "https://cdn.example/penpot/"
    );
    assert.equal(BackendSettings.fromEnvironment({}).assetsUri, undefined);
    assert.equal(
        BackendSettings.fromEnvironment({ PENPOT_MCP_ASSETS_URI: "http://localhost:9002/" }).assetsUri,
        "http://localhost:9002/"
    );
    for (const value of ["ftp://x.example/", "https://user:pass@x.example/", "https://x.example/?q=1", "not a uri"]) {
        assert.throws(() => BackendSettings.readAssetsUri({ PENPOT_MCP_ASSETS_URI: value }), /PENPOT_MCP_ASSETS_URI/);
    }
});
