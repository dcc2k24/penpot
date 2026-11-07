import assert from "node:assert/strict";
import { test } from "node:test";
import { SandboxSettings } from "./SandboxSettings";

test("defaults apply when the variables are unset or blank", () => {
    const settings = SandboxSettings.fromEnvironment({
        PENPOT_MCP_SANDBOX_TIMEOUT_S: undefined,
        PENPOT_MCP_SANDBOX_IDLE_MIN: "   ",
    });
    assert.equal(settings.cpuBudgetMs, 3_000);
    assert.equal(settings.idleEvictMs, 30 * 60 * 1000);
});

test("the default CPU budget is 3 s, so one script cannot hold the event loop for 10 s", () => {
    assert.equal(SandboxSettings.DEFAULT_CPU_BUDGET_MS, 3_000);
});

test("custom values are read in seconds and minutes", () => {
    const settings = SandboxSettings.fromEnvironment({
        PENPOT_MCP_SANDBOX_TIMEOUT_S: "2.5",
        PENPOT_MCP_SANDBOX_IDLE_MIN: "5",
    });
    assert.equal(settings.cpuBudgetMs, 2500);
    assert.equal(settings.idleEvictMs, 5 * 60 * 1000);
});

test("malformed values throw an error that names the variable", () => {
    for (const [name, value] of [
        ["PENPOT_MCP_SANDBOX_TIMEOUT_S", "soon"],
        ["PENPOT_MCP_SANDBOX_TIMEOUT_S", "0"],
        ["PENPOT_MCP_SANDBOX_TIMEOUT_S", "-3"],
        ["PENPOT_MCP_SANDBOX_IDLE_MIN", "abc"],
        ["PENPOT_MCP_SANDBOX_IDLE_MIN", "Infinity"],
        ["PENPOT_MCP_SANDBOX_WALL_S", "soon"],
        ["PENPOT_MCP_SANDBOX_WALL_S", "0"],
    ]) {
        assert.throws(
            () => SandboxSettings.fromEnvironment({ [name]: value }),
            (error: unknown) => error instanceof Error && error.message.includes(name)
        );
    }
});

test("the new limits default to their documented values", () => {
    const settings = new SandboxSettings();
    assert.equal(settings.wallMs, 120_000);
    assert.equal(settings.maxHostCalls, 1000);
    assert.equal(settings.maxSessions, 20);
    assert.equal(settings.maxConcurrentCalls, 4);
    assert.equal(settings.slotWaitMs, 60_000);
});

test("the defaults of the new limits apply when the environment is empty", () => {
    const settings = SandboxSettings.fromEnvironment({});
    assert.equal(settings.wallMs, 120_000);
    assert.equal(settings.maxHostCalls, 1000);
    assert.equal(settings.maxSessions, 20);
    assert.equal(settings.maxConcurrentCalls, 4);
    assert.equal(settings.slotWaitMs, 60_000);
});

test("PENPOT_MCP_SANDBOX_WALL_S overrides the wall-clock limit in seconds", () => {
    const settings = SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_WALL_S: "30" });
    assert.equal(settings.wallMs, 30_000);
});

test("PENPOT_MCP_SANDBOX_MAX_HOST_CALLS overrides the host call limit", () => {
    const settings = SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_MAX_HOST_CALLS: "250" });
    assert.equal(settings.maxHostCalls, 250);
});

test("PENPOT_MCP_SANDBOX_MAX_SESSIONS overrides the session limit", () => {
    const settings = SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_MAX_SESSIONS: "7" });
    assert.equal(settings.maxSessions, 7);
});

test("PENPOT_MCP_SANDBOX_MAX_CONCURRENT overrides the concurrent call limit", () => {
    const settings = SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_MAX_CONCURRENT: "2" });
    assert.equal(settings.maxConcurrentCalls, 2);
});

test("malformed integer values throw an error that names the variable", () => {
    for (const [name, value] of [
        ["PENPOT_MCP_SANDBOX_MAX_HOST_CALLS", "2.5"],
        ["PENPOT_MCP_SANDBOX_MAX_HOST_CALLS", "0"],
        ["PENPOT_MCP_SANDBOX_MAX_HOST_CALLS", "many"],
        ["PENPOT_MCP_SANDBOX_MAX_SESSIONS", "1.5"],
        ["PENPOT_MCP_SANDBOX_MAX_SESSIONS", "-1"],
        ["PENPOT_MCP_SANDBOX_MAX_CONCURRENT", "2.5"],
        ["PENPOT_MCP_SANDBOX_MAX_CONCURRENT", "Infinity"],
    ]) {
        assert.throws(
            () => SandboxSettings.fromEnvironment({ [name]: value }),
            (error: unknown) => error instanceof Error && error.message.includes(name)
        );
    }
});

test("workers are on by default, and a false value switches them off", () => {
    assert.equal(SandboxSettings.fromEnvironment({}).workers, true);
    assert.equal(SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_WORKERS: "false" }).workers, false);
    assert.equal(SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_WORKERS: "0" }).workers, false);
    assert.equal(SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_WORKERS: " TRUE " }).workers, true);
    assert.equal(SandboxSettings.workersEnabled({}), true);
});

test("a malformed workers value throws an error that names the variable", () => {
    assert.throws(
        () => SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_WORKERS: "maybe" }),
        /PENPOT_MCP_SANDBOX_WORKERS must be true or false/
    );
});

test("the page cap is 16 MB by default, and PENPOT_MCP_SANDBOX_PAGE_MB sets it in MB", () => {
    assert.equal(SandboxSettings.fromEnvironment({}).maxPageBytes, 16 * 1024 * 1024);
    assert.equal(SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_PAGE_MB: "32" }).maxPageBytes, 32 * 1024 * 1024);
    assert.equal(SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_PAGE_MB: "0.5" }).maxPageBytes, 512 * 1024);
});

test("a malformed page cap throws an error that names its variable", () => {
    assert.throws(
        () => SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_PAGE_MB: "lots" }),
        /PENPOT_MCP_SANDBOX_PAGE_MB/
    );
    assert.throws(
        () => SandboxSettings.fromEnvironment({ PENPOT_MCP_SANDBOX_PAGE_MB: "0" }),
        /PENPOT_MCP_SANDBOX_PAGE_MB/
    );
});
