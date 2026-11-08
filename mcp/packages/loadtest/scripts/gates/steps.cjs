// prints per-step max/p50 of a result file
const r = require(process.argv[2]);
for (const s of r.steps)
    console.log(`${s.name.padEnd(34)} n=${s.calls} err=${s.errors} p50=${s.p50.toFixed(0)} max=${s.max.toFixed(0)}`);
