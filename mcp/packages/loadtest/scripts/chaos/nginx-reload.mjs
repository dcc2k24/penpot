// Plan addition 14, case 2: nginx is reloaded (nginx -s reload) while calls run through the balancer.
//
// Expected: a reload keeps the workers that serve the calls and starts new ones; at most one call fails across the
// whole run, and the reload itself succeeds (nginx -t first).
//
// Usage:
//   node nginx-reload.mjs --dry-run
//   node nginx-reload.mjs --yes --token-file <file> --vars <vars.json> [--url http://127.0.0.1:4415/mcp]
//
// --yes is required: the case reloads nginx of the stack. Reload changes no state, so there is no cleanup to run.

import { BALANCER_MCP_URL, runCase, dockerExec, outcome, sleep } from "./lib.mjs";

const NAME = "nginx-reload";

const USAGE = `${NAME}: reloads nginx of the two-adapter stack while four callers keep calling through it.
Options: --dry-run, --yes (required to run), --token-file, --vars, --url <balancer MCP URL, default http://127.0.0.1:4415/mcp>,
  --results-dir
Extra: --nginx <deploy-nginx-1>, --duration-s <30>, --reload-at-s <10>, --max-failed <1>`;

await runCase(
    NAME,
    { "--nginx": "deploy-nginx-1", "--duration-s": 30, "--reload-at-s": 10, "--max-failed": 1 },
    async (c) => {
        const { "--nginx": nginx } = c.opts.extra;
        const duration = c.opts.extra["--duration-s"] * 1000;
        const reloadAt = c.opts.extra["--reload-at-s"] * 1000;
        const maxFailed = c.opts.extra["--max-failed"];
        const answers = [];
        let startedAt;
        let reloadOutput;

        await c.step(
            "check the nginx configuration",
            () => dockerExec(nginx, ["nginx", "-t"], { timeoutMs: 30_000 }),
            "nginx -t"
        );

        const callers = await c.step(
            "start four callers that call whoami every 500 ms (8 a second, under the 10 per second token limit)",
            async () => {
                startedAt = Date.now();
                const caller = async () => {
                    while (Date.now() - startedAt < duration) {
                        answers.push({ at: Date.now() - startedAt, answer: await c.call("whoami", {}) });
                        await sleep(500);
                    }
                };
                return Promise.all([caller(), caller(), caller(), caller()]);
            },
            `runs for ${c.opts.extra["--duration-s"]} s`
        );

        await c.step(
            `reload nginx at ${c.opts.extra["--reload-at-s"]} s`,
            async () => {
                while (Date.now() - startedAt < reloadAt) {
                    await sleep(100);
                }
                reloadOutput = await dockerExec(nginx, ["nginx", "-s", "reload"], { timeoutMs: 30_000 });
            },
            "nginx -s reload, inside the container"
        );

        await c.step("wait for the callers to finish", () => callers, "");

        // a rate-limit refusal is the token limit, not the reload; it is counted on its own
        const limited = answers.filter((entry) => /rate limited/i.test(entry.answer.text ?? ""));
        const failed = answers.filter((entry) => !entry.answer.ok && !/rate limited/i.test(entry.answer.text ?? ""));
        c.observe("rateLimited", limited.length);
        c.observe("calls", answers.length);
        c.observe("failed", failed.length);
        c.observe(
            "failedSamples",
            failed.slice(0, 5).map((entry) => ({ at: entry.at, ...outcome(entry.answer) }))
        );
        c.observe("reloadOutput", (reloadOutput ?? "").trim().slice(0, 200));

        c.check("reload succeeds", "nginx -s reload returned without error", typeof reloadOutput === "string", {
            reloadOutput: (reloadOutput ?? "").trim().slice(0, 200),
        });
        c.check(
            "no failed calls beyond the limit",
            `at most ${maxFailed} call fails across the whole run`,
            failed.length <= maxFailed,
            { failed: failed.length, calls: answers.length }
        );
    },
    USAGE,
    BALANCER_MCP_URL
);
