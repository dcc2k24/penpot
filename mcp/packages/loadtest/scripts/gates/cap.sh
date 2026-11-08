#!/usr/bin/env bash
# usage: cap.sh <name> <scenario args...>  runs one capacity run with the pool watch
L=/c/dev/penpot/mcp/packages/loadtest/results/2026-11-08-round1-resumed
LW=C:/dev/penpot/mcp/packages/loadtest/results/2026-11-08-round1-resumed
name=$1; shift
rm -f $L/$name-pool.stop $L/$name-pool.jsonl
node /c/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/cap/poolwatch.cjs $LW/$name-pool.jsonl $LW/$name-pool.stop &
/c/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/run2.sh $name "$@"
touch $L/$name-pool.stop; wait
node /c/Users/colli/AppData/Local/Temp/claude/2f4543b12a7f72c0/367536da-914a-442d-83aa-fee0ff1931ef/scratchpad/round1/gates/cap/poolsum.cjs $LW/$name-pool.jsonl > $L/$name-pool-summary.json
