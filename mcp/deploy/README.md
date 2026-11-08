# Two-adapter test stack

This stack runs two Penpot MCP adapters, one Redis and one nginx. nginx spreads
requests over the two adapters in turn. The stack shows that the adapters share
their state, so a second adapter does not break the limits.

Files:

- `compose.two-adapters.yaml`: the services. The adapters are `penpot-mcp-1` and
  `penpot-mcp-2`, and they also join the dev stack's `penpot_penpot` network.
- `nginx.conf`: the round-robin balancer.
- `build-image.sh`: builds the adapter image. See "Building the image" below.

## What it proves

- **Rate limit.** Each MCP token has one bucket in Redis. Both adapters draw from
  it, so the limit stays the same with two adapters.
- **Sandbox storage.** A value that one adapter stores in `execute_code` is read
  back through the other adapter.
- **Write queue.** The queue stays inside each process. The backend file lock keeps
  writes to one file in order across processes. This stack does not test write
  order.

## Prerequisites

- The dev stack on this machine:
  - backend on `http://localhost:6061/`, with `enable-mcp-backend` in `PENPOT_FLAGS`;
  - exporter on `http://localhost:6062/`;
  - frontend on `http://localhost:9002/`.
- Docker with Compose v2.
- The dev stack must be up first. Its Docker network `penpot_penpot` must exist,
  because the adapters join it. Check with `docker network ls`.
- An adapter image built from this branch. See "Building the image" below.

## Building the image

The stack uses the image `penpot-mcp-local:two-adapters`, built from the working
tree. The released image does not have the Redis code of this branch.

Run once from the repo root:

```sh
mcp/deploy/build-image.sh
```

The script:

1. Copies `mcp` and `plugins` to a temporary folder, without their `node_modules`,
   `dist` and `.git`.
2. Runs `scripts/build` in that copy, which makes the bundle. This is slow.
3. Copies the bundle to `docker/images/bundle-mcp`, where the Dockerfile reads it.
4. Builds the image with `docker compose ... build`. No container starts.

The build runs in the copy, so `mcp/node_modules` and `mcp/dist` in your working
tree stay as they are. A running adapter on your machine keeps running. The script
prints a note when port 4405 answers.

It needs pnpm, Docker with Compose v2, and network access. Rebuild after code
changes.

## How to run

Run these from the repo root. The stack owner runs the start and stop commands.

Build the image first with `mcp/deploy/build-image.sh`, unless it is already built.

```sh
# Check the file. This prints the resolved configuration and starts nothing.
docker compose -f mcp/deploy/compose.two-adapters.yaml config

# Start the stack in the background.
docker compose -f mcp/deploy/compose.two-adapters.yaml up -d

# Stop the stack and remove its volumes.
docker compose -f mcp/deploy/compose.two-adapters.yaml down -v
```

The balancer listens on host port `4415`. Set `PENPOT_MCP_LB_PORT` to change it.
No adapter and no Redis port is published on the host.

## How another agent tests it

Set the balancer URL and a token in your shell. Get the token the way the MCP help
center describes (the link is in the Usage section of `mcp/README.md`). Do not
write the token into a file.

```sh
export LB=http://localhost:4415
export TOKEN='<your MCP token>'
```

### a. Balancer health

```sh
curl -s -i "$LB/lb-healthz"
```

Expect `HTTP/1.1 200 OK` and the body `ok`. This checks nginx only.

### b. Adapter health through the balancer

```sh
for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code}\n" "$LB/healthz"; done
```

Expect `200` four times. Each request goes to one adapter, so the four calls reach
both.

### c. Storage round trip through two adapters

The calls go to `$LB/mcp` with the `Authorization: Bearer` header. The `execute_code`
tool needs a file id from the dev backend. Get one with `list_files`.

Write a value through one adapter, then read it through the other:

```sh
call() {
  curl -s -X POST "$LB/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
}

# First call: store a value. Use a real fileId from list_files.
call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_code","arguments":{"fileId":"<fileId>","code":"storage.t2probe = 42; return storage.t2probe;"}}}'

# Second call: read it back. The reply should show 42.
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"execute_code","arguments":{"fileId":"<fileId>","code":"return storage.t2probe;"}}}'
```

If the server asks for `initialize` first, send it before these calls and report it.
Round robin sends the two calls to different adapters. Check which adapter took each
call. Compose prefixes every log line with its service name:

```sh
docker compose -f mcp/deploy/compose.two-adapters.yaml logs --no-color penpot-mcp-1 penpot-mcp-2 | grep "Received MCP request"
```

The nginx access log also prints each request with its upstream address:

```sh
docker compose -f mcp/deploy/compose.two-adapters.yaml logs --no-color nginx
```

The two calls should show up in the adapter logs with different service names.
If both show the same adapter, rerun the calls and report it.

### d. Shared rate limit

The burst is 20 and the sustained rate is 10 calls a second. Send 25 calls at once
with one token. Wait at least 5 seconds before each run so the bucket is full.

```sh
# Wait for the bucket to fill.
sleep 5
OUT="$HOME/t2-rate"
mkdir -p "$OUT"
rm -f "$OUT"/rl-*.txt
for i in $(seq 1 25); do
  call '{"jsonrpc":"2.0","id":'$i',"method":"tools/call","params":{"name":"whoami","arguments":{}}}' > "$OUT/rl-$i.txt" &
done
wait

echo "refused: $(grep -l 'rate limited' "$OUT"/rl-*.txt | wc -l)"
echo "admitted: $(grep -L 'rate limited' "$OUT"/rl-*.txt | wc -l)"
```

Expect about 20 admitted and 5 refused with `rate limited, retry after N s`.
The total must stay near 20, not near 40, even though two adapters serve the calls.
Calls can take a little more than the burst if the 25 calls take longer than a tenth
of a second, because the bucket refills at 10 a second.

To see both adapters take part, repeat the 25 calls with a short pause and check the
adapter logs as in step c.

## Settings that change the behaviour

These variables are set in the compose file. Change them with a shell variable or
by editing the file.

- `PENPOT_MCP_RATE_LIMIT_RPS` (default `10`). Calls per second that one token may
  make, over all adapters.
- `PENPOT_MCP_RATE_LIMIT_BURST` (default `20`). Calls one token may make at once.
- `PENPOT_MCP_SANDBOX_IDLE_MIN` (default `30`). Minutes without a call after which
  the sandbox state of a token, including its `storage`, is dropped.
- `PENPOT_MCP_REDIS_URI`. Set in the compose file to `redis://redis:6379`. When
  Redis does not answer, each adapter falls back to its own rate limit, so the
  limit is again per process. The adapter also skips the storage copy to Redis.

## What is not covered

- No TLS. The balancer serves plain HTTP on port 4415.
- No active health checks. nginx open source checks only passively. The compose
  healthchecks and the steps above probe `/healthz`.
- No metrics scrape in this stack. `compose.monitoring.yaml` and `prometheus.yml`
  in `mcp/deploy` scrape `penpot-mcp-1` and `penpot-mcp-2` on the `penpot_penpot`
  network. That is a separate stack.
- Redis is not persistent. A restart clears the rate limit and the storage copies.
- No write-order test across adapters.
