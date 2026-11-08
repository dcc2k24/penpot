// Group 2: the backend switches. Two cases need a backend restart with a flag off, so they are not testable here.
import { guard, makeCase, notTestable, rpc } from "./lib.mjs";

/** Group name, used in the report and the runner. */
export const name = "2-backend-switch";

/**
 * Runs the group.
 *
 * @param {{ cfg: object, control: object, log: (msg: string) => void }} ctx - suite context
 * @returns {Promise<object[]>} the cases
 */
export async function run(ctx) {
    const { cfg } = ctx;
    const cases = [];

    cases.push(
        ...(await guard(
            { group: name, id: "2.01", title: "backend flag enable-mcp-backend off answers mcp-backend-disabled" },
            async () =>
                notTestable(
                    {
                        group: name,
                        id: "2.01",
                        title: "backend flag enable-mcp-backend off answers mcp-backend-disabled",
                        request: "MCP token call with enable-mcp-backend off",
                        expected: "HTTP 400 mcp-backend-disabled",
                        severity: "high",
                    },
                    "needs a backend restart with the flag off, which this suite must not do. Manual steps: restart " +
                        "the backend without the flag enable-mcp-backend, then call whoami with a token: expect " +
                        "mcp-backend-disabled, HTTP 400."
                )
        ))
    );

    cases.push(
        ...(await guard(
            { group: name, id: "2.02", title: "raw changes flag off answers mcp-raw-changes-disabled" },
            async () =>
                notTestable(
                    {
                        group: name,
                        id: "2.02",
                        title: "raw changes flag off answers mcp-raw-changes-disabled",
                        request: "apply_raw_changes with enable-mcp-raw-changes off",
                        expected: "HTTP 400 mcp-raw-changes-disabled",
                        severity: "medium",
                    },
                    "needs a backend restart with the flag enable-mcp-raw-changes off, which this suite must not do. " +
                        "Manual steps: restart the backend without that flag, then call apply_raw_changes with a " +
                        "token: expect mcp-raw-changes-disabled, HTTP 400."
                )
        ))
    );

    cases.push(
        ...(await guard(
            { group: name, id: "2.03", title: "backend answers mcp-whoami with the full token (flag is on)" },
            async () => {
                const meta = {
                    group: name,
                    id: "2.03",
                    title: "backend answers mcp-whoami with the full token (flag is on)",
                    request: "POST /api/rpc/command/mcp-whoami {} with the full token",
                    expected: "HTTP 200 with profileId",
                    severity: "high",
                    allowIds: [cfg.vars.profileId],
                };
                const o = await rpc(cfg, "mcp-whoami", {}, { token: cfg.fullToken });
                const verdict =
                    o.status === 200 && o.json && o.json.profileId
                        ? true
                        : `expected HTTP 200 with profileId, got HTTP ${o.status}`;
                return makeCase(meta, o, verdict);
            }
        ))
    );

    return cases;
}
