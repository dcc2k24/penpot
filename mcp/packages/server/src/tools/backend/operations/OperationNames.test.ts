import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OPERATION_NAMES } from "./OperationSchemas";

/**
 * The folder of the CLJC operation families, which the backend validates against.
 *
 * It sits at the repository root: seven folders up from this test, then `common`.
 */
const FAMILIES_PATH = fileURLToPath(
    new URL("../../../../../../../common/src/app/common/mcp/operations", import.meta.url)
);

/**
 * Reads the op names from every family file in the CLJC operations folder.
 *
 * Each op is a map entry keyed by its name, written as `"op_name" {:schema ...}`. The name also appears as the
 * title of its schema, but the map key is the one that the family files use to register an op.
 *
 * @throws Error when the folder holds no family file, which means the path is wrong or the layout changed
 */
function cljcOperationNames(): string[] {
    const families = fs.existsSync(FAMILIES_PATH)
        ? fs.readdirSync(FAMILIES_PATH).filter((file) => file.endsWith(".cljc"))
        : [];
    if (families.length === 0) {
        throw new Error(
            `No CLJC operation family files were found in ${FAMILIES_PATH}. ` +
                "The pin test reads every .cljc file there; fix the path or the layout."
        );
    }
    const names = new Set<string>();
    for (const family of families) {
        const source = fs.readFileSync(`${FAMILIES_PATH}/${family}`, "utf8");
        for (const match of source.matchAll(/"([a-z_]+)"\s*\{\s*:schema\b/g)) {
            names.add(match[1]);
        }
    }
    return [...names];
}

test("the TypeScript op names are the op names of the CLJC families, and no others", () => {
    const fromCljc = cljcOperationNames();
    assert.ok(fromCljc.length > 0, "the CLJC families register their operations");
    assert.deepEqual([...OPERATION_NAMES].sort(), [...fromCljc].sort());
});

test("no op name appears twice in the TypeScript table", () => {
    assert.equal(new Set(OPERATION_NAMES).size, OPERATION_NAMES.length);
});
