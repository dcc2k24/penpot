// node poolsum.cjs <jsonl>: summary of a pool watch
const rows = require("fs")
    .readFileSync(process.argv[2], "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((r) => !r.err);
const n = rows.length,
    max = (k) => Math.max(...rows.map((r) => r[k] ?? 0));
const share = (f) => ((100 * rows.filter(f).length) / n).toFixed(0) + "%";
const mx = max("max");
console.log(
    JSON.stringify({
        samples: n,
        poolMax: mx,
        activeMax: max("active"),
        activeAtMaxShare: share((r) => r.active >= mx),
        connsMax: max("conns"),
        pendingMax: max("pending"),
        pendingAbove0Share: share((r) => r.pending > 0),
        timeouts: (rows[n - 1].timeouts ?? 0) - (rows[0].timeouts ?? 0),
        acquireP95msMax: (max("acq95") / 1e6).toFixed(1),
        climitWaitingMax: max("climitWaiting"),
        climitRejected: (rows[n - 1].climitRejected ?? 0) - (rows[0].climitRejected ?? 0),
    })
);
