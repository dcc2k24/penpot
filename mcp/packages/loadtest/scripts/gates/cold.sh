#!/usr/bin/env bash
# usage: cold.sh <a|b> <n>  restarts the dev backend, waits for it, then runs the cold scenario
L=/c/dev/penpot/mcp/packages/loadtest/results/2026-11-08-round1-resumed
x=$1; n=$2
t0=$(date +%s)
docker exec penpot-tc //usr/local/bin/restart-backend-dev > $L/cold-$x$n-restart.log 2>&1
for i in $(seq 1 120); do curl -s -o /dev/null -w "%{http_code}" http://localhost:6061/metrics | grep -q 200 && break; sleep 2; done
echo "backend up after $(( $(date +%s) - t0 )) s" >> $L/cold-$x$n-restart.log
/c/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/run2.sh cold-$x$n C:/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/cold/cold-$x.json --tokens C:/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/tokens-n20c.txt
