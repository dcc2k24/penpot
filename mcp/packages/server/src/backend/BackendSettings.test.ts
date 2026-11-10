import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendSettings } from "./BackendSettings";

test("defaults match the documented values", () => {
    const settings = BackendSettings.fromEnvironment({});
    assert.equal(settings.timeoutSeconds, 55);
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

test("the backend response cap defaults to 8 MB", () => {
    assert.equal(BackendSettings.fromEnvironment({}).maxResponseMb, 8);
    assert.equal(BackendSettings.readMaxResponseMb({}), 8);
});

test("PENPOT_MCP_BACKEND_MAX_RESPONSE_MB sets the backend response cap", () => {
    assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: "8" }), 8);
    assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: " 0.5 " }), 0.5);
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: "16" }).maxResponseMb, 16);
});

for (const value of ["abc", "0", "-3", "Infinity", "NaN"]) {
    test(`PENPOT_MCP_BACKEND_MAX_RESPONSE_MB=${JSON.stringify(value)} is a startup error that names the variable`, () => {
        assert.throws(
            () => BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: value }),
            /PENPOT_MCP_BACKEND_MAX_RESPONSE_MB/
        );
        assert.throws(
            () => BackendSettings.fromEnvironment({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: value }),
            /PENPOT_MCP_BACKEND_MAX_RESPONSE_MB/
        );
    });
}

test("a blank response cap falls back to 8 MB", () => {
    assert.equal(BackendSettings.readMaxResponseMb({ PENPOT_MCP_BACKEND_MAX_RESPONSE_MB: "   " }), 8);
});

test("the query-parameter token is accepted by default in bridge mode only", () => {
    assert.equal(BackendSettings.fromEnvironment({}, "bridge").allowQueryToken, true);
    assert.equal(BackendSettings.fromEnvironment({}, "backend").allowQueryToken, false);
    assert.equal(BackendSettings.fromEnvironment({}, "both").allowQueryToken, false);
});

test("an explicit PENPOT_MCP_ALLOW_QUERY_TOKEN wins over the mode default", () => {
    assert.equal(
        BackendSettings.fromEnvironment({ PENPOT_MCP_ALLOW_QUERY_TOKEN: "true" }, "both").allowQueryToken,
        true
    );
    assert.equal(
        BackendSettings.fromEnvironment({ PENPOT_MCP_ALLOW_QUERY_TOKEN: "false" }, "bridge").allowQueryToken,
        false
    );
});

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

test("the token cache period defaults to 60 seconds in every mode", () => {
    for (const mode of ["bridge", "backend", "both"]) {
        assert.equal(BackendSettings.fromEnvironment({}, mode).tokenCacheSeconds, 60);
    }
});

test("PENPOT_MCP_TOKEN_CACHE_S sets the token cache period in every mode", () => {
    const env = { PENPOT_MCP_TOKEN_CACHE_S: "15" };
    assert.equal(BackendSettings.fromEnvironment(env, "bridge").tokenCacheSeconds, 15);
    assert.equal(BackendSettings.fromEnvironment(env, "backend").tokenCacheSeconds, 15);
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_TOKEN_CACHE_S: " 2.5 " }).tokenCacheSeconds, 2.5);
});

for (const value of ["soon", "0", "-5"]) {
    test(`PENPOT_MCP_TOKEN_CACHE_S=${value} is a startup error that names the variable`, () => {
        assert.throws(
            () => BackendSettings.fromEnvironment({ PENPOT_MCP_TOKEN_CACHE_S: value }),
            /PENPOT_MCP_TOKEN_CACHE_S/
        );
    });
}

test("PENPOT_MCP_REDIS_URI is unset by default", () => {
    assert.equal(BackendSettings.fromEnvironment({}).redisUri, undefined);
    assert.equal(BackendSettings.readRedisUri({ PENPOT_MCP_REDIS_URI: "  " }, "backend"), undefined);
});

test("a valid PENPOT_MCP_REDIS_URI is kept in backend and both mode", () => {
    const env = { PENPOT_MCP_REDIS_URI: " redis://cache.example:6379/0 " };
    assert.equal(BackendSettings.fromEnvironment(env, "backend").redisUri, "redis://cache.example:6379/0");
    assert.equal(BackendSettings.fromEnvironment(env, "both").redisUri, "redis://cache.example:6379/0");
    assert.equal(
        BackendSettings.fromEnvironment({ PENPOT_MCP_REDIS_URI: "rediss://cache.example:6380" }, "backend").redisUri,
        "rediss://cache.example:6380"
    );
});

test("PENPOT_MCP_REDIS_URI is ignored in bridge mode", () => {
    assert.equal(
        BackendSettings.fromEnvironment({ PENPOT_MCP_REDIS_URI: "redis://cache.example:6379" }, "bridge").redisUri,
        undefined
    );
});

test("PENPOT_MCP_REDIS_URI with another scheme is a startup error that does not echo the value", () => {
    const value = "http://user:s3cret-password@cache.example:6379";
    assert.throws(
        () => BackendSettings.fromEnvironment({ PENPOT_MCP_REDIS_URI: value }, "backend"),
        (error: Error) =>
            error.message.includes("PENPOT_MCP_REDIS_URI") &&
            !error.message.includes("s3cret-password") &&
            !error.message.includes("cache.example")
    );
});

test("a malformed PENPOT_MCP_REDIS_URI is a startup error that does not echo the value", () => {
    assert.throws(
        () => BackendSettings.readRedisUri({ PENPOT_MCP_REDIS_URI: "s3cret not a uri" }, "backend"),
        (error: Error) => error.message.includes("PENPOT_MCP_REDIS_URI") && !error.message.includes("s3cret")
    );
});

test("the shared export permits default to 4 and read PENPOT_MCP_EXPORT_TOTAL_PERMITS", () => {
    assert.equal(BackendSettings.fromEnvironment({}).exportTotalPermits, 4);
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_TOTAL_PERMITS: " " }).exportTotalPermits, 4);
    assert.equal(BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_TOTAL_PERMITS: "6" }).exportTotalPermits, 6);
});

for (const value of ["soon", "0", "-2", "1.5"]) {
    test(`PENPOT_MCP_EXPORT_TOTAL_PERMITS=${value} is a startup error that names the variable`, () => {
        assert.throws(
            () => BackendSettings.fromEnvironment({ PENPOT_MCP_EXPORT_TOTAL_PERMITS: value }),
            /PENPOT_MCP_EXPORT_TOTAL_PERMITS/
        );
    });
}

test("the export batch size defaults to 10 and the render cache to 64 MB", () => {
    const settings = BackendSettings.fromEnvironment({});
    assert.equal(settings.exportBatchSize, 10);
    assert.equal(settings.exportCacheMb, 64);
    assert.equal(BackendSettings.readExportBatchSize({}), 10);
    assert.equal(BackendSettings.readExportCacheMb({}), 64);
});

test("PENPOT_MCP_EXPORT_BATCH_SIZE and PENPOT_MCP_EXPORT_CACHE_MB are read from the environment", () => {
    const settings = BackendSettings.fromEnvironment({
        PENPOT_MCP_EXPORT_BATCH_SIZE: " 50 ",
        PENPOT_MCP_EXPORT_CACHE_MB: "4096",
    });
    assert.equal(settings.exportBatchSize, 50);
    assert.equal(settings.exportCacheMb, 4096);
    assert.equal(BackendSettings.readExportBatchSize({ PENPOT_MCP_EXPORT_BATCH_SIZE: "1" }), 1);
});

test("PENPOT_MCP_EXPORT_CACHE_MB of 0 is accepted and turns the cache off", () => {
    assert.equal(BackendSettings.readExportCacheMb({ PENPOT_MCP_EXPORT_CACHE_MB: "0" }), 0);
});

test("a blank export batch size or cache size falls back to the default", () => {
    assert.equal(BackendSettings.readExportBatchSize({ PENPOT_MCP_EXPORT_BATCH_SIZE: "  " }), 10);
    assert.equal(BackendSettings.readExportCacheMb({ PENPOT_MCP_EXPORT_CACHE_MB: "" }), 64);
});

for (const [name, value] of [
    ["PENPOT_MCP_EXPORT_BATCH_SIZE", "0"],
    ["PENPOT_MCP_EXPORT_BATCH_SIZE", "51"],
    ["PENPOT_MCP_EXPORT_BATCH_SIZE", "2.5"],
    ["PENPOT_MCP_EXPORT_BATCH_SIZE", "many"],
    ["PENPOT_MCP_EXPORT_CACHE_MB", "-1"],
    ["PENPOT_MCP_EXPORT_CACHE_MB", "4097"],
    ["PENPOT_MCP_EXPORT_CACHE_MB", "0.5"],
    ["PENPOT_MCP_EXPORT_CACHE_MB", "big"],
]) {
    test(`${name}=${value} is a startup error that names the variable`, () => {
        assert.throws(() => BackendSettings.fromEnvironment({ [name]: value }), new RegExp(name));
    });
}
