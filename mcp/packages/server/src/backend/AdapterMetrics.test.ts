import assert from "node:assert/strict";
import { test } from "node:test";
import { AdapterMetrics } from "./AdapterMetrics";

test("render writes the TYPE lines and the samples of counter and gauge families", () => {
    const metrics = new AdapterMetrics();
    const text = metrics.render([
        {
            name: "penpot_mcp_rate_limit_fallback_total",
            help: "Rate limit checks answered by the in-process bucket because Redis failed.",
            type: "counter",
            samples: [{ value: 3 }],
        },
        {
            name: "penpot_mcp_redis_up",
            help: "1 when the last Redis rate limit call succeeded, 0 when it failed.",
            type: "gauge",
            samples: [{ value: 0 }],
        },
    ]);
    assert.match(text, /^# TYPE penpot_mcp_rate_limit_fallback_total counter$/m);
    assert.match(text, /^penpot_mcp_rate_limit_fallback_total 3$/m);
    assert.match(text, /^# TYPE penpot_mcp_redis_up gauge$/m);
    assert.match(text, /^penpot_mcp_redis_up 0$/m);
});
