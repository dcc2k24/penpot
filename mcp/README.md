![mcp-server-cover-github-1](https://github.com/user-attachments/assets/dcd14e63-fecd-424f-9a50-c1b1eafe2a4f)

# Penpot's Official MCP Server

Penpot integrates a LLM layer built on the Model Context Protocol
(MCP) via Penpot's Plugin API to interact with a Penpot design
file. Penpot's MCP server enables LLMs to perform data queries,
transformation and creation operations.

Penpot's MCP Server is unlike any other you've seen. You get
design-to- design, code-to-design and design-code supercharged
workflows.


[![Penpot MCP video playlist](https://github.com/user-attachments/assets/204f1d99-ce51-41dd-a5dd-1ef739f8f089)](https://www.youtube.com/playlist?list=PLgcCPfOv5v57SKMuw1NmS0-lkAXevpn10)


## Architecture

The **Penpot MCP Server** exposes tools to AI clients (LLMs), which
support the retrieval of design data as well as the modification and
creation of design elements.  The MCP server communicates with Penpot
via the dedicated **Penpot MCP Plugin**,
which connects to the MCP server via WebSocket.  
This enables the LLM to carry out tasks in the context of a design file by 
executing code that leverages the Penpot Plugin API.
The LLM is free to write and execute arbitrary code snippets
within the Penpot Plugin environment to accomplish its tasks.

![Architecture](resources/architecture.png)

This repository thus contains not only the MCP server implementation itself
but also the supporting Penpot MCP Plugin 
(see section [Repository Structure](#repository-structure) below).

## Demonstration

[![Video](https://v32155.1blu.de/penpot/PenpotFest2025_thumbnail.png)](https://v32155.1blu.de/penpot/PenpotFest2025.mp4)


## Usage

> [!IMPORTANT]
> **These instructions are for local MCP server usage only!**
>
> The instructions below are for users who want to run the server locally,
> allowing the server to have access to local files, which can be 
> relevant for development/coding tasks.
> 
> If you need to work only on designs, the centrally hosted **remote MCP server**
> should be considered instead. 
> Please refer to the [MCP usage instructions in the help center](https://help.penpot.app/mcp/).

To run the Penpot MCP server locally, you must
 * run the MCP server and connect your AI client to it,
 * run the web server providing the Penpot MCP plugin, and
 * open the Penpot MCP plugin in Penpot and connect it to the MCP server. 

Follow the steps below to enable the integration.

### Prerequisites

The project requires [Node.js](https://nodejs.org/) 20 or later (tested with v22.x).

### 1. Starting the MCP Server and the Plugin Server

#### Running a Released Version via npx

The easiest way to launch the servers is to use `npx` to run the appropriate
version that matches your Penpot version.

If you are using the latest Penpot release, e.g. as served on [design.penpot.app](https://design.penpot.app), run:
```shell
npx -y @penpot/mcp@latest
```

Once the servers are running, continue with step 2.

#### Running the Source Version from the Repository

The tools `pnpm` and `npx` should be available in your terminal.

On Windows, use the Git Bash terminal to ensure compatibility with the provided scripts.

##### Clone the Appropriate Branch of the Repository 

Clone the Penpot repository, using the proper branch/tag depending on the
version of Penpot you want to use the MCP server with.  
For instance, to target the latest development version, use the `develop` branch:

```shell
git clone https://github.com/penpot/penpot.git --branch develop --depth 1
```

Then change into the `mcp` directory:

```shell
cd penpot/mcp
```

##### Build & Launch the MCP Server and the Plugin Server

If it's your first execution, install the required dependencies.
(If you are using the Penpot devenv, this step is not necessary, as dependencies are already installed.)

```shell
./scripts/setup
```

Then build all components and start the two servers:

```shell
pnpm run bootstrap
```

This bootstrap command will:

  * install dependencies for all components
  * build all components
  * start all components

### 2. Load the Plugin in Penpot and Establish the Connection

> [!NOTE]
> **Browser Connectivity Restrictions**
>
> Starting with Chromium version 142, the private network access (PNA) restrictions have been hardened,
> and when connecting to `localhost` from a web application served from a different origin
> (such as https://design.penpot.app), the connection must explicitly be allowed.
>
> Most Chromium-based browsers (e.g. Chrome, Vivaldi) will display a popup requesting permission
> to access the local network. Be sure to approve the request to allow the connection.
>
> Some browsers take additional security measures, and you may need to disable them.
> For example, in Brave, disable the "Shield" for the Penpot website to allow local network access.
>
> If your browser refuses to connect to the locally served plugin, check its configuration or
> try a different browser (e.g. Firefox) that does not enforce these restrictions.

1. Open Penpot in your browser
2. Navigate to a design file
3. Open the Plugins menu
4. Load the plugin using the development URL (`http://localhost:4400/manifest.json` by default)
5. Open the plugin UI
6. In the plugin UI, click "Connect to MCP server".
   The connection status should change from "Not connected" to "Connected".
   (Check the browser's developer console for WebSocket connection logs.
   Check the MCP server terminal for WebSocket connection messages.)

> [!IMPORTANT]
> Do not close the plugin's UI while using the MCP server, as this will close the connection.
> Also keep the Penpot tab active during long MCP sessions. Browsers may freeze, suspend,
> or unload inactive tabs to save resources; when that happens, the MCP server will reject
> tasks until the tab wakes up or reconnects. In Chrome, add your Penpot site to
> **Settings → Performance → Always keep these sites active** or pin the tab to reduce
> tab deactivation.

### 3. Connect an MCP Client

> [!IMPORTANT]  
> **Use an appropriate model.**
> 
> We recommend that you ...
>   * use the most capable model at your disposal. 
>     You will achieve the best results with frontier models, 
>     especially when dealing with more complex tasks.
>     Weaker models, including most locally hosted ones, 
>     are unlikely to produce usable results for anything beyond simple tasks.
>   * use a vision language model (VLM), as many design tasks necessitate visual
>     inspection. 
>     (If you are using a standard commercial model, it almost certainly supports vision already.)

By default, the server provides a Streamable HTTP endpoint at `http://localhost:4401/mcp`.
Simply configure the client to connect the MCP server by providing the respective URL.

The legacy `/sse` and `/messages` endpoints are no longer supported.
Clients using the legacy SSE transport must switch to Streamable HTTP at `/mcp`.

You can change the port by setting the `PENPOT_MCP_SERVER_PORT` environment variable
before starting the server. This endpoint can be used directly by MCP clients that support Streamable HTTP.

#### Automatically configuring your client

You can configure your client with the [add-mcp](https://github.com/neon-solutions/add-mcp) helper.
Simply call 

    npx -y add-mcp -g -n penpot http://localhost:4401/mcp

and follow the interactive dialogue to configure the clients of your choice.
The config entry name is `penpot` (override it with `-n <name>`) and the URL points to the local http
endpoint (adjust the port if you changed `PENPOT_MCP_SERVER_PORT`).

When using a client that only supports stdio transport like **Claude Desktop**,
a proxy like [mcp-remote](https://github.com/geelen/mcp-remote) is required. 
More information on connecting your client follows below.

#### Using a Proxy for stdio Transport

The `mcp-remote` package can proxy stdio transport to Streamable HTTP,
allowing clients that support only stdio to connect to the MCP server indirectly.
Use it to provide the launch command for your MCP client as follows:

        npx -y mcp-remote http://localhost:4401/mcp --allow-http

#### Example: Claude Desktop

For Windows and macOS, there is the official [Claude Desktop app](https://claude.ai/download), which you can use as an MCP client.
For Linux, there is an [unofficial community version](https://github.com/aaddrick/claude-desktop-debian).

Since Claude Desktop natively supports only stdio transport, you will need to use a proxy like `mcp-remote`.
Install it as described above.

To add the server to Claude Desktop's configuration, locate the configuration file (or find it via Menu / File / Settings / Developer):

- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add a `penpot` entry under `mcpServers` with the following content: 

```json
{
    "mcpServers": {
        "penpot": {
            "command": "npx",
            "args": ["-y", "mcp-remote", "http://localhost:4401/mcp", "--allow-http"]
        }
    }
}
```

After updating the configuration file, restart Claude Desktop completely for the changes to take effect.

> [!IMPORTANT] 
> Be sure to fully quit the app for the changes to take effect; closing the window is *not* sufficient.   
> To fully terminate the app, choose Menu / File / Quit.

After the restart, you should see the MCP server listed when clicking on the "Search and tools" icon at the bottom
of the prompt input area.

### Working with Multiple Files

Connect the files you want to use:

* Open each file in a separate Penpot tab, run the plugin, and connect it to the same MCP server.
* Each browser tab uses a short session ID derived only from `penpot.currentUser.sessionId`, shown in the plugin UI with a **Copy** button. The ID stays the same across workspace navigation.
* Multiple tabs can connect to the same file. Connecting or disconnecting one tab does not disconnect the others.

Choose a session for your agent:

* With exactly one connected session, the server selects it automatically when the agent omits the session ID.
* With several connected sessions, the server lists them and asks the agent to have you select one.
* You can also copy an ID from the plugin and include it in your prompt, for example:
  "Use Penpot session `o37vgcqsvt` and list the pages in that file."

For integrated remote MCP connection controls and session behavior, see the
[Help Center guide](../docs/mcp/index.md#working-with-multiple-files).

## Repository Structure

This repository is a monorepo containing four main components:

1. **Common Types** (`packages/common/`):
    - Shared TypeScript definitions for request/response protocol
    - Ensures type safety across server and plugin components

2. **Penpot MCP Server** (`packages/server/`):
    - Provides MCP tools to LLMs for Penpot interaction
    - Runs a WebSocket server accepting connections from the Penpot MCP plugin
    - Implements request/response correlation with unique task IDs
    - Handles task timeouts and proper error reporting

3. **Penpot MCP Plugin** (`packages/plugin/`):
    - Connects to the MCP server via WebSocket
    - Executes tasks in Penpot using the Plugin API
    - Sends structured responses back to the server#

4. **Types Generator** (`types-generator/`):
    - Generates data on API types for the MCP server (development use)

The core components are written in TypeScript, rendering interactions with the
Penpot Plugin API both natural and type-safe.

## Configuration

The Penpot MCP server can be configured using environment variables.

### Server Configuration

| Environment Variable                             | Description                                                                                                                                                                                                                                                                 | Default        |
|--------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------|
| `PENPOT_MCP_SERVER_HOST`                         | Address on which the MCP server listens (binds to)                                                                                                                                                                                                                          | `localhost`    |
| `PENPOT_MCP_KEEPALIVE_S`                         | Seconds the server keeps an idle HTTP connection open. Keep it above the idle timeout of the proxy in front (`deploy/nginx.conf` uses 60 s).                                                 | `65`           |
| `PENPOT_MCP_SERVER_PORT`                         | Port for the MCP server                                                                                                                                                                                                                                                     | `4401`         |
| `PENPOT_MCP_WEBSOCKET_PORT`                      | Port for the WebSocket server (plugin connection)                                                                                                                                                                                                                           | `4402`         |
| `PENPOT_MCP_REPL_PORT`                           | Port for the REPL server (development/debugging)                                                                                                                                                                                                                            | `4403`         |
| `PENPOT_MCP_REPL_HOST`                           | Address on which the REPL server listens (binds to)                                                                                                                                                                                                                         | `localhost`    |
| `PENPOT_MCP_REPL_ENABLE`                         | Explicitly enable/disable the REPL server. Set to `true` to enable. When unset, defaults to the value of `PENPOT_MCP_DEVENV`. The REPL server never starts in multi-user mode.                                                                                              | (unset)        |
| `PENPOT_MCP_REMOTE_MODE`                         | Enable remote mode (disables file system access). Set to `true` to enable.                                                                                                                                                                                                  | `false`        |
| `PENPOT_MCP_DEVENV`                              | Enable Penpot development environment tools in local single-user mode. Set to `true` to enable.                                                                                                                                                                             | `false`        |
| `PENPOT_MCP_TOOL_TIMEOUT_S`                      | Timeout, in seconds, for tool calls dispatched to the Penpot plugin                                                                                                                                                                                                         | `120`          |
| `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS`  | Maximum number of export shape requests that run at once in one process. In backend mode the backend export tools default to 4.                                                                                                                                                                                                    | `0` (no limit) in bridge mode, `4` in backend mode |
| `PENPOT_MCP_EXPORT_TOTAL_PERMITS` | Most renders that run at once across all adapters that share `PENPOT_MCP_REDIS_URI`. Each permit lasts at most 65 s. Without Redis, each process uses its own cap. | `4` |
| `PENPOT_MCP_AUTH_URI` | Public base URL of the MCP authorization service, e.g. `https://penpot.example/api/mcp/oauth`. Set to enable OAuth; requires `--multi-user`. Use HTTPS (HTTP is allowed on loopback for development), without credentials, query parameters, or a fragment. | (unset; OAuth disabled) |
| `PENPOT_MCP_REDIS_URI`                           | Redis connection URI (for example `redis://host:6379`). In multi-user mode it routes plugin tasks between instances (see above). In backend and both mode it shares the rate limit and the sandbox `storage` across adapters; when Redis does not answer, the adapter uses its own in-process rate limit and skips the storage copy. Requires Redis 5 or later. | (unset)        |
| `PENPOT_MCP_TOKEN_CACHE_S` | Seconds that a successful token check is reused before the backend is asked again. A revoked token keeps working on each adapter for up to this long after the revocation. Lowering it costs one `mcp-whoami` call per token per interval on each adapter. | `60` |
| `PENPOT_MCP_BACKEND_URI` | Penpot instance base URI. Setting a nonblank value enables the backend tools (`submit_feedback` and, in backend or both mode, the tools in [Backend mode](#backend-mode)). The MCP server appends suffixes such as `api/main/methods/send-mcp-feedback`. Backend interactions require MCP user tokens to be provided.  | (unset) |
| `PENPOT_MCP_MODE` | Which tools the server offers: `bridge` (plugin tools only), `backend` (backend tools only, no plugin bridge and no WebSocket server) or `both`. `backend` and `both` require `PENPOT_MCP_BACKEND_URI`. In `both` mode the plugin tools are named `execute_code_in_tab`, `export_shape_from_tab` and `import_image_in_tab`. Setting `PENPOT_MCP_BACKEND_URI` alone does not change the mode. | `bridge` |
| `PENPOT_MCP_ALLOW_QUERY_TOKEN` | Accept the MCP token as the `userToken` query parameter. Set to `false` to accept only the `Authorization` header; a request with the query parameter then gets a 401. A warning is logged once per token when the parameter is used. | `true` in bridge mode, `false` in backend and both mode |
| `PENPOT_MCP_RATE_LIMIT_RPS` | Sustained requests per second allowed for each MCP token in backend mode | `10` |
| `PENPOT_MCP_RATE_LIMIT_BURST` | Requests each MCP token may send at once in backend mode | `20` |
| `PENPOT_MCP_BACKEND_TIMEOUT_S` | Timeout, in seconds, for each call to the Penpot backend | `55` |
| `PENPOT_MCP_EXPORTER_URI` | Base URI of the Penpot exporter service. The `export_shape` backend tool posts export requests to its root path. | `http://localhost:6061/` |
| `PENPOT_MCP_ASSETS_URI` | Base URI that serves `/assets/by-id/` for downloads of export results and of `mode: fill` media. Set it when the backend answers asset requests with HTTP 204 and an `x-accel-redirect` header, which nginx turns into the file. Unset, the server downloads from the origin of the URI that the exporter answers with, which is the public URI. A fill download has no exporter answer, so it uses `PENPOT_MCP_BACKEND_URI` when this is unset. | (unset) |
| `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB` | Cap, in megabytes, on the body of one backend or exporter response. A larger response fails with an error that names this variable. | `8` |
| `PENPOT_MCP_MAX_BODY_MB` | Largest HTTP request body the server accepts, in megabytes. The same limit caps the base64 text that `import_archive` and `import_image` accept inline, so an archive above it must be given as `filePath` or `url`. | `32` |
| `PENPOT_MCP_SANDBOX_TIMEOUT_S` | CPU time, in seconds, that one `execute_code` call may use in backend mode. | `3` |
| `PENPOT_MCP_SANDBOX_IDLE_MIN` | Minutes without a call after which the sandbox state of an MCP token (its runtime and its `storage`) is dropped. | `30` |
| `PENPOT_MCP_EXPORT_DIR` | Absolute directory that the `filePath` argument of the export tools may write to. Paths outside it, including through symbolic links, are refused. | `penpot-exports` in the home directory of the user who runs the server |
| `PENPOT_MCP_IMPORT_DIR` | Absolute directory that the `filePath` argument of the import tools may read from. Paths outside it, including through symbolic links, are refused. | `penpot-imports` in the home directory of the user who runs the server |
| `PENPOT_MCP_SANDBOX_WALL_S` | Wall-clock limit, in seconds, of one `execute_code` call in backend mode. | `120` |
| `PENPOT_MCP_SANDBOX_MAX_HOST_CALLS` | Most host calls that one `execute_code` script may make in backend mode. | `1000` |
| `PENPOT_MCP_SANDBOX_MAX_SESSIONS` | Most live sandbox runtimes in backend mode, and most saved `storage` copies. Each runtime holds a worker thread, so keep this low. | `20` |
| `PENPOT_MCP_SANDBOX_MAX_CONCURRENT` | Most `execute_code` calls that run at once in backend mode, across all tokens. A token still runs one at a time. The default is `20`. It does not follow `PENPOT_MCP_SANDBOX_MAX_SESSIONS`. | `20` |
| `PENPOT_MCP_SANDBOX_HOST_MS` | Host time, in milliseconds, that one `execute_code` script may spend in backend and exporter calls, rate-limit waits included. A script that reads in a flood ends here with a clear error. | `30000` |
| `PENPOT_MCP_SANDBOX_PAGE_MB` | Most page data, in MB of JSON, that one `execute_code` call may hold in backend mode. The guest parses each page as JSON inside a 256 MB WebAssembly memory, and a parsed page takes several times its JSON size, so the default leaves room for the script's own data. A page above the cap fails with its id, shape count and size; use `apply_operations` and `get_shapes`/`find_shapes` for such a page, or raise the setting. | `16` |
| `PENPOT_MCP_MAX_TOOL_RESPONSE_KB` | Largest JSON answer of one backend tool, in kilobytes (1 to 10000). Longer answers are cut. | `100` |

`PENPOT_MCP_SANDBOX_WORKERS` sets where a sandbox script runs in backend mode. The default, `true`, runs each token's sandbox in a worker thread, so a script that spins for its CPU budget no longer stalls other requests. The server stops a worker that runs past its wall-clock limit, and the next call of that token starts a new worker with the `storage` saved from the last call. Set the variable to `false` to run every script on the main thread, as before. The saved `storage` is JSON: a value that JSON cannot hold, such as a `Map`, a function or a cyclic object, is lost when its worker is stopped, and a `storage` above 8 MB of JSON is not saved; the call then says so and the previous copy is kept. Memory: each worker's JavaScript heap is capped at 512 MB, and its WebAssembly memory can grow to 256 MB. Lower `PENPOT_MCP_SANDBOX_MAX_SESSIONS` on a small server. Workers need the worker entry in the build; see `packages/server/src/sandbox/WORKER_THREADS.md`.

### Health and metrics endpoints

The MCP server serves these endpoints without a token:

- `/healthz` returns `ok` while the process is up. It does not check the backend.
- `/readyz` returns `ready` (HTTP 200) when the backend is ready, or `not ready` (HTTP 503) when it is not. Without `PENPOT_MCP_BACKEND_URI`, it returns `ready` while the process is up.
- `/metrics` returns metrics in the Prometheus text format.

For more detail, see the MCP section of the [configuration guide](../docs/technical-guide/configuration.md#mcp).

### Backend Configuration

If `PENPOT_MCP_BACKEND_URI` is set, the backend must itself be configured correspondingly, i.e. set
the following variables for the backend process:

| Environment Variable | Description | Default |
|----------------------|-------------|---------|
| `PENPOT_MCP_FEEDBACK_EMAIL` | Selects the inbox for MCP feedback. Unset means the command rejects submissions. Requires the `enable-mcp` or `enable-access-tokens` flag and uses the backend's existing SMTP configuration. | (unset) |


### Logging Configuration

| Environment Variable   | Description                                          | Default  |
|------------------------|------------------------------------------------------|----------|
| `PENPOT_MCP_LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error` | `info`   |
| `PENPOT_MCP_LOG_DIR`   | Directory for log files; file logging is enabled iff this is set to a non-empty value | (unset)  |

### Plugin Server Configuration

| Environment Variable                      | Description                                                                             | Default      |
|-------------------------------------------|-----------------------------------------------------------------------------------------|--------------|
| `PENPOT_MCP_PLUGIN_SERVER_HOST`           | Address on which the plugin web server listens (single address or comma-separated list) | (local only) |

## The Server's Modes of Operation

The above instructions describe how to run the MCP server and plugin server locally,
for a single user – its simplest mode of operation.

The server supports additional modes of operation, which are intended for
non-local usage (and which are relevant to hosted deployments only).
Some of the aforementioned configuration options control these modes.

* **remote mode**:  
  In remote mode, the server is not assumed to be accessed by a local user on the same machine,
  with corresponding limitations being enforced (tools offering local file system access are restricted/disabled).

* **multi-user mode**:  
  In multi-user mode, the server can be accessed by multiple users simultaneously.
  This mode always implies *remote mode*.
  User tokens are passed to the server both when connecting an MCP client and when establishing
  plugin connections, associating each connection with the respective user and allowing tasks to be routed to the correct Penpot instance.
  This mode is intended for hosted deployments using the integrated version of the Penpot MCP plugin, 
  which automatically sends the user token to the server when establishing WebSocket connections.
  It is enabled by running the server with the `--multi-user` flag.

* **multi-instance mode**:  
  In multi-instance mode, multiple instances of the MCP server can be run in parallel (load balancing).
  This can result in connections from the same user being owned by different server instances,
  making it necessary to dispatch tasks to the correct instance. This is handled through Redis,
  and the mode is thus enabled by setting the environment variable providing the Redis connection URI.

## Backend mode

In backend mode the server talks to the Penpot backend directly. It reads and writes files in the database,
so no browser tab with the plugin has to be open. Set `PENPOT_MCP_MODE=backend` (or `both`, to keep the plugin
tools too) and `PENPOT_MCP_BACKEND_URI`:

```sh
PENPOT_MCP_MODE=backend PENPOT_MCP_BACKEND_URI=https://penpot.example/ node dist/index.js
```

The backend tools follow one discovery flow, with explicit ids at every step:
`whoami` → `list_teams` → `list_projects` → `list_files` → `get_file_outline` → `get_page_tree` → `get_shapes`.
Writes go through `apply_operations` (typed operations, `$tmp:` handles for shapes created in the same call) or
`apply_raw_changes`. Every write accepts `dryRun`, `snapshot`, `baseRevn` and `failOnConflict`.
The `high_level_overview` tool returns the backend instructions in this mode; the file is
`packages/server/data/backend_instructions.md`.

Each MCP token is validated against the backend (`mcp-whoami`, cached for 60 seconds) and limited to
`PENPOT_MCP_RATE_LIMIT_RPS` requests per second. Writes by one token to one file run one after another in each server process.
Request bodies are capped at `PENPOT_MCP_MAX_BODY_MB`, and backend responses at `PENPOT_MCP_BACKEND_MAX_RESPONSE_MB`.
Exports wait for a slot: at most `PENPOT_MCP_EXPORT_SHAPE_MAX_PARALLEL_REQUESTS` run at once in one process (4 by default in backend mode). With Redis, at most `PENPOT_MCP_EXPORT_TOTAL_PERMITS` (4 by default) run at once across all adapters.
A failed tool call returns `isError: true` with the failure text.
Each tool call writes one log line with the tool name, the token fingerprint, the duration and the outcome.
A token needs the scopes of the tools it calls: `mcp:read` for reads, `mcp:write` for design changes,
`mcp:manage` for team, project and file management, and `mcp:delete` for deletions.

Writes by one token to one file run one after another in each server process. The queue only stops the backend's `climit` from rejecting too many queued writes. The backend file lock is what keeps writes to one file in order across processes. So the queue stays per process. With `PENPOT_MCP_REDIS_URI` set, several adapters behind a round-robin balancer need no sticky routing, because the rate limit and the sandbox `storage` are shared through Redis.

Redis must be version 5 or later, because the rate limit script reads the Redis clock and then writes. When Redis does not answer, each adapter limits requests with its own bucket. When Redis comes back, a token's Redis bucket starts at the level that adapter has left, so the token does not get a full burst at once. A revoked token keeps working on each adapter for up to `PENPOT_MCP_TOKEN_CACHE_S` seconds (default 60) after the revocation.

In `both` mode the plain tool names belong to the backend tools, such as `whoami`, `apply_operations`,
`execute_code`, `export_shape` and `import_image`. The plugin tools get new names: `execute_code_in_tab`,
`export_shape_from_tab` and `import_image_in_tab`. Clients that call the plugin tools by their old names must
switch to the new names. To keep the old names and drop the backend tools, set `PENPOT_MCP_MODE=bridge`.

When `PENPOT_MCP_MODE` is unset, the server runs in `bridge` mode even if `PENPOT_MCP_BACKEND_URI` is set, and logs a
warning that the backend tools are off. Set `PENPOT_MCP_MODE` to `backend` or `both` to serve them.

The `import_archive` tool takes a `url` only in local mode. The server downloads it, follows at most five
redirects and refuses loopback, private, link-local, unique-local, CGNAT and unspecified addresses.

## Development

* The [contribution guidelines for Penpot](../CONTRIBUTING.md) apply
* Auto-formatting: Use `pnpm run fmt`
* Generating API type data: See [types-generator/README.md](types-generator/README.md)
* Versioning: Use `bash scripts/set-version` to set the version for the MCP package (in `package.json`).
  - Ensure that at least the major, minor and patch components of the version are always up-to-date.
  - The MCP plugin assumes that a mismatch between the MCP version and the Penpot version (as returned by the API) 
    indicates incompatibility, resulting in the display of a warning message in the plugin UI.
* Packaging and publishing:
  1. Ensure that the API type data is up-to-date (see above).
  2. Ensure release version is set correctly in package.json (call `bash scripts/set-version` to update it automatically)
  3. Create npm package: `bash scripts/pack` (creates `penpot-mcp-<version>.tgz` for publishing)
  4. Publish to npm: `npm publish penpot-mcp-<version>.tgz --access public`
