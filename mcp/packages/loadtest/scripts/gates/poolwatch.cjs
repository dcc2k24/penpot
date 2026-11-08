// node poolwatch.cjs <out.jsonl> <stopfile>: samples pool and climit series every second until stopfile exists
const fs = require("fs");
const [out, stop] = process.argv.slice(2);
const pick = (t, re) => {
    let s = 0,
        f = false;
    for (const l of t.split("\n")) {
        if (l.startsWith("#")) continue;
        if (re.test(l)) {
            const v = +l.trim().split(/\s+/).pop();
            if (!isNaN(v)) {
                s += v;
                f = true;
            }
        }
    }
    return f ? s : null;
};
const tick = async () => {
    if (fs.existsSync(stop)) process.exit(0);
    try {
        const t = await (await fetch("http://localhost:6061/metrics")).text();
        fs.appendFileSync(
            out,
            JSON.stringify({
                t: Date.now(),
                active: pick(t, /^hikaricp_active_connections\{pool="main"/),
                pending: pick(t, /^hikaricp_pending_threads\{pool="main"/),
                conns: pick(t, /^hikaricp_connections\{pool="main"/),
                max: pick(t, /^hikaricp_max_connections\{pool="main"/),
                timeouts: pick(t, /^hikaricp_connection_timeout_total\{pool="main"/),
                acq95: pick(t, /^hikaricp_connection_acquired_nanos\{pool="main",quantile="0.95"/),
                climitWaiting: pick(t, /^penpot_rpc_climit_waiting/),
                climitRejected: pick(t, /^penpot_rpc_climit_rejected_total/),
                rlimit: pick(t, /^penpot_rpc_rlimit\w*_total/),
            }) + "\n"
        );
    } catch (e) {
        fs.appendFileSync(out, JSON.stringify({ t: Date.now(), err: String(e) }) + "\n");
    }
    setTimeout(tick, 1000);
};
tick();
