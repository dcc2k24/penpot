import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationLoader } from "./ConfigurationLoader";

test("the backend instructions that high_level_overview returns have the Geometry semantics section", () => {
    const loader = new ConfigurationLoader(process.cwd());
    assert.match(loader.getBackendInstructions(), /^## Geometry semantics$/m);
});
