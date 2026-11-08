// Checks that a Prometheus /metrics endpoint serves well-formed text exposition (format 0.0.4).
//
// Usage: node scripts/check-metrics.mjs <metrics-url> [--no-promtool]
//
// The script checks, in order:
//   - one `# TYPE` line per family, declared before its samples, with a known type;
//   - at most one `# HELP` line per family;
//   - every sample belongs to a declared family (histogram and summary suffixes included);
//   - label names are valid and label values are properly escaped;
//   - no duplicate samples (same name and label set);
//   - every label set of a family uses the same label names (`le` excluded);
//   - sample values are finite numbers;
//   - histogram buckets are cumulative, ordered by `le`, and the `+Inf` bucket equals `_count`.
//
// It prints the families, then the defects, and exits 1 on any defect. Unless `--no-promtool` is given, it also
// runs `promtool check metrics` in the prom/prometheus image through docker, when docker is available, and
// exits 1 when promtool rejects the text too. Without docker the promtool step is reported as skipped.

import { spawnSync } from "node:child_process";

const PROMTOOL_IMAGE = "prom/prometheus:v3.5.0";
const KNOWN_TYPES = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)(\s+-?\d+)?$/;

/**
 * Parses the label block of a sample line, for example `{tool="a",outcome="ok"}`.
 *
 * @param {string} block - the text between and including the braces
 * @returns {{labels: Record<string, string>, error?: string}}
 */
export function parseLabels(block) {
    const labels = {};
    const body = block.slice(1, -1);
    let i = 0;
    while (i < body.length) {
        const eq = body.indexOf("=", i);
        if (eq < 0) {
            return { labels, error: `label without '=' in ${block}` };
        }
        const name = body.slice(i, eq);
        if (!LABEL_NAME.test(name)) {
            return { labels, error: `invalid label name '${name}'` };
        }
        if (body[eq + 1] !== '"') {
            return { labels, error: `label '${name}' value is not quoted` };
        }
        let j = eq + 2;
        let value = "";
        let closed = false;
        while (j < body.length) {
            const ch = body[j];
            if (ch === "\\") {
                const next = body[j + 1];
                if (next !== "\\" && next !== '"' && next !== "n") {
                    return { labels, error: `label '${name}' has a bad escape '\\${next}'` };
                }
                value += next === "n" ? "\n" : next;
                j += 2;
                continue;
            }
            if (ch === '"') {
                closed = true;
                j += 1;
                break;
            }
            value += ch;
            j += 1;
        }
        if (!closed) {
            return { labels, error: `label '${name}' value is not closed` };
        }
        if (name in labels) {
            return { labels, error: `label '${name}' appears twice` };
        }
        labels[name] = value;
        if (body[j] === ",") {
            j += 1;
        } else if (j < body.length) {
            return { labels, error: `expected ',' after label '${name}'` };
        }
        i = j;
    }
    return { labels };
}

/**
 * Validates one exposition text and collects its families.
 *
 * @param {string} text - the exposition text
 * @returns {{families: Map<string, {type: string, help: boolean, samples: object[]}>, defects: string[]}}
 */
export function checkExposition(text) {
    const defects = [];
    const families = new Map();
    const seen = new Set();
    const lines = text.split("\n");
    if (text.length === 0 || !text.endsWith("\n")) {
        defects.push("the text is empty or does not end with a newline");
    }

    lines.forEach((raw, index) => {
        const where = `line ${index + 1}`;
        const line = raw.trimEnd();
        if (line === "") {
            return;
        }
        if (line.startsWith("#")) {
            const help = /^# HELP (\S+) (.*)$/.exec(line);
            const type = /^# TYPE (\S+) (\S+)$/.exec(line);
            if (help) {
                const family = ensureFamily(help[1]);
                if (family.help) {
                    defects.push(`${where}: second HELP for ${help[1]}`);
                }
                family.help = true;
            } else if (type) {
                const [, name, kind] = type;
                if (!KNOWN_TYPES.has(kind)) {
                    defects.push(`${where}: unknown type '${kind}' for ${name}`);
                }
                const family = ensureFamily(name);
                if (family.type !== undefined) {
                    defects.push(`${where}: second TYPE for ${name}`);
                }
                if (family.samples.length > 0) {
                    defects.push(`${where}: TYPE for ${name} comes after its samples`);
                }
                family.type = kind;
            } else if (!line.startsWith("# ")) {
                defects.push(`${where}: malformed comment '${line}'`);
            }
            return;
        }

        const match = SAMPLE_LINE.exec(line);
        if (!match) {
            defects.push(`${where}: not a sample line: '${line}'`);
            return;
        }
        const [, name, block, value] = match;
        let labels = {};
        if (block !== undefined) {
            const parsed = parseLabels(block);
            if (parsed.error) {
                defects.push(`${where}: ${parsed.error}`);
            }
            labels = parsed.labels;
        }
        const number = Number(value);
        if (!(value === "NaN" || Number.isFinite(number))) {
            defects.push(`${where}: ${name} has a non-finite value '${value}'`);
        }
        const familyName = familyOf(name);
        if (familyName === undefined) {
            defects.push(`${where}: sample ${name} has no # TYPE line before it`);
            return;
        }
        const family = families.get(familyName);
        const key = `${name}|${Object.entries(labels)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")}`;
        if (seen.has(key)) {
            defects.push(`${where}: duplicate sample ${name}${block ?? ""}`);
        }
        seen.add(key);
        family.samples.push({ name, labels, value: number, line: index + 1 });
    });

    for (const [name, family] of families) {
        if (family.type === undefined) {
            defects.push(`family ${name} has no # TYPE line`);
            continue;
        }
        const labelSets = new Set(
            family.samples.map((s) =>
                Object.keys(s.labels)
                    .filter((k) => k !== "le" && k !== "quantile")
                    .sort()
                    .join(",")
            )
        );
        if (labelSets.size > 1) {
            defects.push(`family ${name} uses different label names across its samples: ${[...labelSets].join(" | ")}`);
        }
        if (family.type === "histogram") {
            checkHistogram(name, family, defects);
        }
    }
    return { families, defects };

    function ensureFamily(name) {
        if (!families.has(name)) {
            families.set(name, { type: undefined, help: false, samples: [] });
        }
        return families.get(name);
    }

    // Maps a sample name to the family it belongs to: the name itself, or a histogram or summary suffix.
    function familyOf(sampleName) {
        if (families.has(sampleName) && families.get(sampleName).type !== undefined) {
            return sampleName;
        }
        for (const suffix of ["_bucket", "_sum", "_count"]) {
            if (sampleName.endsWith(suffix)) {
                const base = sampleName.slice(0, -suffix.length);
                const family = families.get(base);
                if (family && (family.type === "histogram" || family.type === "summary")) {
                    return base;
                }
            }
        }
        return undefined;
    }
}

/**
 * Checks the buckets of one histogram family: cumulative, ordered by `le`, and `+Inf` equal to `_count`.
 *
 * @param {string} name - family name
 * @param {{samples: object[]}} family - the family
 * @param {string[]} defects - list to append to
 */
function checkHistogram(name, family, defects) {
    const series = new Map();
    for (const sample of family.samples) {
        const { le, ...rest } = sample.labels;
        const key = Object.entries(rest)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join(",");
        if (!series.has(key)) {
            series.set(key, { buckets: [], count: undefined });
        }
        const entry = series.get(key);
        if (sample.name === `${name}_bucket`) {
            if (le === undefined) {
                defects.push(`histogram ${name} has a bucket without le (line ${sample.line})`);
                continue;
            }
            entry.buckets.push({ le: le === "+Inf" ? Infinity : Number(le), value: sample.value, line: sample.line });
        } else if (sample.name === `${name}_count`) {
            entry.count = sample.value;
        }
    }
    for (const [key, entry] of series) {
        const label = key === "" ? name : `${name}{${key}}`;
        const sorted = [...entry.buckets].sort((a, b) => a.le - b.le);
        sorted.forEach((bucket, i) => {
            if (Number.isNaN(bucket.le)) {
                defects.push(`${label}: bucket with a non-numeric le (line ${bucket.line})`);
            }
            if (i > 0 && bucket.value < sorted[i - 1].value) {
                defects.push(`${label}: buckets are not cumulative at le=${bucket.le} (line ${bucket.line})`);
            }
        });
        const inf = sorted.find((b) => b.le === Infinity);
        if (inf === undefined) {
            defects.push(`${label}: no le="+Inf" bucket`);
        } else if (entry.count !== undefined && inf.value !== entry.count) {
            defects.push(`${label}: le="+Inf" (${inf.value}) differs from _count (${entry.count})`);
        }
    }
}

/**
 * Runs `promtool check metrics` in the prom/prometheus image, feeding the text on stdin.
 *
 * @param {string} text - the exposition text
 * @returns {{status: "ok" | "failed" | "skipped", output: string}}
 */
function runPromtool(text) {
    const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
    if (probe.status !== 0) {
        return { status: "skipped", output: "docker is not available" };
    }
    const run = spawnSync(
        "docker",
        ["run", "--rm", "-i", "--entrypoint", "promtool", PROMTOOL_IMAGE, "check", "metrics"],
        { input: text, encoding: "utf8" }
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    return { status: run.status === 0 ? "ok" : "failed", output };
}

async function main() {
    const args = process.argv.slice(2);
    const usePromtool = !args.includes("--no-promtool");
    const url = args.find((a) => !a.startsWith("--"));
    if (url === undefined) {
        console.error("usage: node scripts/check-metrics.mjs <metrics-url> [--no-promtool]");
        process.exit(2);
    }

    let text;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
            console.error(`${url}: HTTP ${response.status}`);
            process.exit(1);
        }
        text = await response.text();
    } catch (error) {
        console.error(`${url}: ${error.message}`);
        process.exit(1);
    }

    const { families, defects } = checkExposition(text);
    const samples = [...families.values()].reduce((n, f) => n + f.samples.length, 0);
    console.log(`${url}: ${families.size} families, ${samples} samples`);
    for (const [name, family] of families) {
        console.log(`  ${family.type ?? "?"}\t${name}\t${family.samples.length} samples`);
    }
    for (const defect of defects) {
        console.log(`DEFECT ${defect}`);
    }

    let promtoolFailed = false;
    if (usePromtool) {
        const result = runPromtool(text);
        console.log(`promtool check metrics: ${result.status}`);
        if (result.output !== "") {
            console.log(result.output);
        }
        promtoolFailed = result.status === "failed";
    } else {
        console.log("promtool check metrics: not run (--no-promtool)");
    }

    if (defects.length > 0 || promtoolFailed) {
        process.exit(1);
    }
    console.log("OK");
}

if (process.argv[1]?.endsWith("check-metrics.mjs")) {
    await main();
}
