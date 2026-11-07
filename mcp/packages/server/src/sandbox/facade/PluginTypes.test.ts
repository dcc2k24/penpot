import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { PropertyMap } from "../PropertyMap";
import { API_SOURCE } from "./ApiSource";

/*
 * Drift check between the facade and the Plugin API types. Each member of the listed interfaces must be named by the
 * facade, or be listed in UNSUPPORTED with the reason. A name counts as named when the facade source or the property
 * table has it as a key or a method, so the check is coarse: it catches a member that the facade never names, not a
 * member that is named but wrong.
 */

/** Interfaces of the Plugin API whose members the facade must cover. */
const CHECKED = ["Shape", "Board", "Text", "Penpot", "Library"];

/**
 * Members of the checked interfaces that the backend mode does not provide, keyed by `Interface.member`. Each entry
 * says why the facade does not build it.
 */
const UNSUPPORTED: Record<string, string> = {
    "Shape.isMask": "not built yet; the mask state of a group is not read",
    "Shape.toD": "not built yet; the path data of a boolean is not read",
    "Shape.getRange": "not built yet; text ranges are not in the facade",
    "Shape.applyTypography": "not built yet; text ranges are not in the facade",
    "Text.getRange": "not built yet; text ranges are not in the facade",
    "Text.applyTypography": "not built yet; text ranges are not in the facade",
    "Penpot.version": "not built yet; the server reports no plugin API version",
    "Library.deletedComponents": "not built yet; deleted components are not listed",
};

const require = createRequire(import.meta.url);

/**
 * Finds the declaration file of the Plugin API types. The server package does not depend on it, so the test skips
 * when it is missing. PLUGIN_TYPES_DTS points the check at another copy of the file.
 *
 * @returns the path of the declaration file, or undefined when none is found
 */
function locateTypes(): string | undefined {
    const override = process.env.PLUGIN_TYPES_DTS;
    if (override !== undefined && existsSync(override)) {
        return override;
    }
    try {
        const manifest = require.resolve("@penpot/plugin-types/package.json");
        const file = join(dirname(manifest), "index.d.ts");
        return existsSync(file) ? file : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Collects the member names of an interface, following its extends clauses and Omit<...> bases.
 *
 * @param sourceFile - parsed declaration file
 * @param name - interface or type alias name
 * @param excluded - member names that an Omit removes
 * @returns the member names, keyed by name, with the interface that declares each one
 */
function membersOf(sourceFile: ts.SourceFile, name: string, excluded: Set<string> = new Set()): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (declName: string, omitted: Set<string>): void => {
        for (const statement of sourceFile.statements) {
            if (ts.isTypeAliasDeclaration(statement) && statement.name.text === declName) {
                // a union such as Shape: every constituent counts
                const collectUnion = (node: ts.TypeNode): void => {
                    if (ts.isUnionTypeNode(node)) {
                        node.types.forEach(collectUnion);
                    } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
                        visit(node.typeName.text, omitted);
                    }
                };
                collectUnion(statement.type);
            }
            if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== declName) {
                continue;
            }
            for (const heritage of statement.heritageClauses ?? []) {
                for (const base of heritage.types) {
                    if (!ts.isIdentifier(base.expression)) {
                        continue;
                    }
                    if (base.expression.text === "Omit" && base.typeArguments?.length === 2) {
                        // Omit<Base, 'a' | 'b'>: the base without the omitted names
                        const [baseType, keys] = base.typeArguments;
                        const removed = new Set(omitted);
                        for (const literal of collectLiterals(keys)) {
                            removed.add(literal);
                        }
                        if (ts.isTypeReferenceNode(baseType) && ts.isIdentifier(baseType.typeName)) {
                            visit(baseType.typeName.text, removed);
                        }
                    } else {
                        visit(base.expression.text, omitted);
                    }
                }
            }
            for (const member of statement.members) {
                if (member.name === undefined || (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name))) {
                    continue;
                }
                const memberName = member.name.text;
                if (!omitted.has(memberName) && !found.has(memberName)) {
                    found.set(memberName, declName);
                }
            }
        }
    };
    visit(name, excluded);
    return found;
}

/**
 * Lists the string literals of a union type, such as the keys of an Omit.
 *
 * @param node - type node
 * @returns the literal texts
 */
function collectLiterals(node: ts.TypeNode): string[] {
    if (ts.isUnionTypeNode(node)) {
        return node.types.flatMap(collectLiterals);
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
        return [node.literal.text];
    }
    return [];
}

/**
 * Tells whether the facade names a member: as a key or a method of its source, or as a key of the property table.
 *
 * @param member - member name
 * @param facadeText - facade source and property table, as one text
 * @returns true when the facade names the member
 */
function namedByFacade(member: string, facadeText: string): boolean {
    const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // a key (name:), a call or a definition (name( or name =), possibly after a dot as in library.createColor = ...;
    // or a quoted name, or a quoted dotted name such as "shape.switchVariant" in the table of not available members
    return new RegExp(`(?<![\\w$])${escaped}\\s*[:(=]|[".]${escaped}"`).test(facadeText);
}

const declarationFile = locateTypes();
const skipReason =
    declarationFile === undefined
        ? "@penpot/plugin-types is not installed in mcp/packages/server; set PLUGIN_TYPES_DTS to check another copy"
        : false;

test(
    "every member of the checked Plugin API types is named by the facade or listed as unsupported",
    { skip: skipReason },
    () => {
        const sourceFile = ts.createSourceFile(
            declarationFile ?? "index.d.ts",
            readFileSync(declarationFile ?? "", "utf8"),
            ts.ScriptTarget.Latest,
            true
        );
        const facadeText = `${API_SOURCE}\n${JSON.stringify(PropertyMap.toJsonTable())}`;
        const missing: string[] = [];
        for (const typeName of CHECKED) {
            for (const [member, declaredIn] of membersOf(sourceFile, typeName)) {
                const key = `${typeName}.${member}`;
                if (namedByFacade(member, facadeText) || UNSUPPORTED[key] !== undefined) {
                    continue;
                }
                missing.push(`${key} (declared in ${declaredIn})`);
            }
        }
        assert.deepEqual(missing, [], "members the facade neither names nor lists as unsupported");
    }
);

test("every UNSUPPORTED entry names a member of the checked types and gives a reason", { skip: skipReason }, () => {
    const sourceFile = ts.createSourceFile(
        declarationFile ?? "index.d.ts",
        readFileSync(declarationFile ?? "", "utf8"),
        ts.ScriptTarget.Latest,
        true
    );
    const known = new Set<string>();
    for (const typeName of CHECKED) {
        for (const member of membersOf(sourceFile, typeName).keys()) {
            known.add(`${typeName}.${member}`);
        }
    }
    for (const [key, reason] of Object.entries(UNSUPPORTED)) {
        assert.ok(known.has(key), `${key} is not a member of the checked types`);
        assert.ok(reason.trim().length > 0, `${key} needs a reason`);
    }
});
