import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { penpotFontDir, requiredSetting, tokenFilePath, varsFilePath } from "./Paths.js";

const TEST_NAME = "DESIGN_PARITY_TEST_SETTING";
const SAVED = new Map<string, string | undefined>();

/**
 * Sets an environment variable for one test and remembers the old value for restoring.
 *
 * @param name - variable name
 * @param value - value, or undefined to unset it
 */
function setEnv(name: string, value: string | undefined): void {
    if (!SAVED.has(name)) {
        SAVED.set(name, process.env[name]);
    }
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

afterEach(() => {
    for (const [name, value] of SAVED) {
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
    SAVED.clear();
});

describe("requiredSetting", () => {
    it("returns the trimmed value when the variable is set", () => {
        setEnv(TEST_NAME, "  /tmp/value.txt  ");
        assert.equal(requiredSetting(TEST_NAME), "/tmp/value.txt");
    });

    it("throws an error that names the variable when it is unset or blank", () => {
        setEnv(TEST_NAME, undefined);
        assert.throws(() => requiredSetting(TEST_NAME), /DESIGN_PARITY_TEST_SETTING is not set/);
        setEnv(TEST_NAME, "   ");
        assert.throws(() => requiredSetting(TEST_NAME), /DESIGN_PARITY_TEST_SETTING is not set/);
    });
});

describe("required settings of the package", () => {
    it("the token file, vars file and font folder have no default", () => {
        setEnv("DESIGN_PARITY_TOKEN_FILE", undefined);
        setEnv("DESIGN_PARITY_VARS_FILE", undefined);
        setEnv("PENPOT_FONT_DIR", undefined);
        assert.throws(() => tokenFilePath(), /DESIGN_PARITY_TOKEN_FILE/);
        assert.throws(() => varsFilePath(), /DESIGN_PARITY_VARS_FILE/);
        assert.throws(() => penpotFontDir(), /PENPOT_FONT_DIR/);
    });

    it("each one reads its own variable", () => {
        setEnv("DESIGN_PARITY_TOKEN_FILE", "/run/token.txt");
        setEnv("DESIGN_PARITY_VARS_FILE", "/run/vars.json");
        setEnv("PENPOT_FONT_DIR", "/run/fonts");
        assert.equal(tokenFilePath(), "/run/token.txt");
        assert.equal(varsFilePath(), "/run/vars.json");
        assert.equal(penpotFontDir(), "/run/fonts");
    });
});

describe("Paths.ts source", () => {
    it("holds no machine-specific path", () => {
        const source = readFileSync(new URL("./Paths.ts", import.meta.url), "utf8");
        for (const machinePart of ["C:" + "/", "/" + "Users" + "/"]) {
            assert.equal(source.includes(machinePart), false, machinePart);
        }
    });
});
