import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendServices } from "./BackendServices";
import { BackendSettings } from "./BackendSettings";
import { RedisExportPermits } from "../utils/RedisExportPermits";
import { RedisRateLimiter } from "./RedisRateLimiter";
import { TokenRateLimiter } from "./TokenRateLimiter";
import { FakeExporterClient } from "./testing/FakeExporterClient";
import { FakePenpotBackend } from "./testing/FakePenpotBackend";

test("without a Redis URI the rate limit is the in-process bucket", async () => {
    const services = new BackendServices(new FakePenpotBackend(), new BackendSettings(), new FakeExporterClient());
    try {
        assert.ok(services.rateLimiter instanceof TokenRateLimiter);
        assert.equal(services.redisLimiter, undefined);
    } finally {
        await services.close();
    }
});

test("with a Redis URI the rate limit is the Redis-backed limiter, and close releases it", async () => {
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_REDIS_URI: "redis://127.0.0.1:1" }, "backend");
    const services = new BackendServices(new FakePenpotBackend(), settings, new FakeExporterClient());
    assert.ok(services.rateLimiter instanceof RedisRateLimiter);
    assert.ok(services.redisLimiter instanceof RedisRateLimiter);
    await services.close();
});

test("with a Redis URI the three Redis clients are reported, and without one none", async () => {
    const plain = new BackendServices(new FakePenpotBackend(), new BackendSettings(), new FakeExporterClient());
    try {
        assert.deepEqual(plain.redisClientStates(), []);
    } finally {
        await plain.close();
    }
    const settings = BackendSettings.fromEnvironment({ PENPOT_MCP_REDIS_URI: "redis://127.0.0.1:1" }, "backend");
    const services = new BackendServices(new FakePenpotBackend(), settings, new FakeExporterClient());
    try {
        assert.ok(services.exportPermits instanceof RedisExportPermits);
        assert.deepEqual(
            services.redisClientStates().map((state) => state.client),
            ["rate-limiter", "storage", "export-permits"]
        );
    } finally {
        await services.close();
    }
});
