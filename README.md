# @u2ai/server

The agent service of the Universal-AI family: an MCP server with the tools of an agent,
a WebSocket bus for editor extensions, a completion bridge for the tab-autocomplete and a
client for the outside MCP servers.

The binary is `ai-serve`. Node.js 26 or newer, ESM, no SDK: the transport of the model is
the global `fetch` of Node, and the WebSocket server is written by hand.

```bash
npm install -g @u2ai/server
ai-serve --help
```

---

## What is inside

| Part | What it does |
|---|---|
| The bus (`src/server/u2ai.js`) | A WebSocket server on `127.0.0.1`: the frames of the protocol `ai-serve`, the runs, the approvals, the questions, the tools held by a client. |
| The HTTP part (`src/server/http.js`) | The routes `/health`, `/v1/tools`, `/v1/serves`, `/v1/complete`, `/v1/structure` on the same port and with the same token. |
| The MCP server (`src/server/mcp.js`) | JSON-RPC 2.0 without an SDK: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`. Stdio or HTTP. |
| The stdio transports (`src/server/stdio.js`, `src/client/stdio.js`) | The line of JSON that goes in and the line of JSON that comes out: the server of the package and the child process of an outside server. |
| The tools (`src/tools/*`) | The catalog of the agent: the filesystem, the terminal, the map of the workspace, the suggestions. |
| The roles (`src/roles/*`) | The loop of the agent: the analyzer, the director, the executor, the tooler, the suggester. |
| The OpenAI layer (`src/openai/*`) | The Responses API first, the Chat Completions as the fallback, the rotation of the backends with the retries. |
| The client (`src/client/*`) | The MCP client (stdio and HTTP) and the proxy of the outside services. |
| The completion (`src/agent/autocomplete.js`) | The window of the document, the prompt of the completion and the clean-up of the insertion. |

---

## Commands

| Command | What it does |
|---|---|
| `ai-serve serve [--port n]` | Run the bus, the HTTP part and the MCP endpoint. Writes `~/.ai-serve/serve.json`. |
| `ai-serve mcp [--stdio\|--http] [--port n]` | Run the MCP server only: stdio by default, HTTP with `--http`. |
| `ai-serve tools [--json]` | The list of the tools of the package: the name, the category, the risk, the description. |
| `ai-serve agent "<task>" [--cwd dir] [--role name]` | A one-off task as an AI agent. Without a role the agent analyzes, plans and does the work. |
| `ai-serve complete --file <path> --line <n>` | A one-off completion for the file and the line. The answer is the text to insert. |
| `ai-serve services [list\|add\|add-mcp\|remove]` | The outside services: their state, their addresses, their tokens. |
| `ai-serve config` | The resolved configuration, with the secrets shortened. |
| `ai-serve doctor` | The check of the environment: Node.js, the home directory, the configuration, the key, the port, the services. |

The exit codes are `0` (done), `1` (a failure), `2` (a usage error) and `130` (interrupted).

### Examples

```bash
ai-serve doctor                       # is the environment ready?
ai-serve tools --json | head -20      # what can the agent do?
ai-serve serve --port 8765            # the bus, the HTTP part and the MCP endpoint

ai-serve agent "name the entry points of this project" --cwd .
ai-serve agent "find the slow tests" --role analyzer
ai-serve complete --file src/index.js --line 42 --language js

ai-serve services add other --url ws://127.0.0.1:9000 --token <token>
ai-serve services add-mcp files --command node --arg server.js
ai-serve services
```

---

## The home directory

Everything the service owns lives in `~/.ai-serve` (the environment variable `AI_SERVE_HOME`
moves it):

| Path | What it is |
|---|---|
| `~/.ai-serve/config.json` | The configuration. |
| `~/.ai-serve/mcp.json` | The outside MCP servers. |
| `~/.ai-serve/skills/` | The skill packs of the roles. |
| `~/.ai-serve/logs/` | The logs. |
| `~/.ai-serve/serve.json` | The address of the running server. Written by the server, mode `0600`, removed when the server stops. |

---

## The configuration

The order of the sources: the defaults, then `~/.ai-serve/config.json`, then the file of
`--config`, then the environment, then the flags of the CLI.

```json
{
  "model": "minimax/minimax-m3.1-flash",
  "reasoning": { "effort": "medium", "summary": "auto" },
  "backends": [
    { "baseURL": "https://routerai.ru/api/v1", "env": "ROUTERAI_API_KEY" },
    { "baseURL": "https://api.proxyapi.ru/v1", "env": "PROXYAPI_API_KEY" }
  ],
  "server": { "host": "127.0.0.1", "port": 0, "approve": "ask" },
  "tools": { "allowWrite": true, "allowTerminal": true },
  "completion": { "enabled": true, "model": null },
  "mcp": { "enabled": true, "transport": "stdio" },
  "roles": {
    "default": { "model": null, "effort": null },
    "executor": { "instructions": "Read before you write." }
  }
}
```

`approve` is the question of the server before it runs a tool: `ask` (every time), `read`,
`write` or `all`. `tools.allowWrite: false` makes the service read-only,
`tools.allowTerminal: false` turns the terminal off.

The strings of the configuration understand the placeholders `{{env:NAME}}` and
`{{file:path}}`.

### The environment

| Name | What it sets |
|---|---|
| `AI_SERVE_HOME` | The home directory of the service. |
| `AI_SERVE_CONFIG` | The file of the configuration. |
| `AI_SERVE_MODEL` (or `AI_MODEL`, `OPENAI_MODEL`) | The model of the agent. |
| `AI_SERVE_BASE_URL` (or `OPENAI_BASE_URL`) | The endpoint of the API. |
| `AI_SERVE_API_KEY` (or `OPENAI_API_KEY`) | The key of the API. |
| `AI_SERVE_EFFORT` | The effort of the reasoning: `minimal`, `low`, `medium`, `high`. |
| `AI_SERVE_RETRIES`, `AI_SERVE_TIMEOUT_MS`, `AI_SERVE_MAX_TURNS` | The limits of the requests and of the loop of the agent. |
| `AI_SERVE_BACKENDS` | The list of the backends as a JSON array. |
| `AI_SERVE_PORT`, `AI_SERVE_HOST`, `AI_SERVE_APPROVE` | The port, the interface and the question of the server. |
| `AI_SERVE_COMPLETION`, `AI_SERVE_MCP`, `AI_SERVE_MCP_TRANSPORT` | The switches of the completion bridge and of the MCP server. |

---

## The protocol `ai-serve`

The bus is a stream of JSON texts over a WebSocket. The version of the protocol is `0.3`;
the client sends it in the `hello` frame.

| Moment | Frame |
|---|---|
| The greeting | client → `{ "type": "hello", "role": "client", "token": "<token>" }`; the server answers `{ "type": "ready", "runs": [...] }`. |
| The start of a run | `{ "type": "start", "command": "ask\|run\|chat\|image", "prompt": "...", "cwd": "...", "approve": "ask", ... }` |
| The announcement of a run | `{ "type": "run.started", "run": { "id": "...", "command": "ask", "cwd": "...", "status": "running" } }` |
| The continuation of a chat | `{ "type": "input", "runId": "...", "text": "..." }` |
| The cancel of a run | `{ "type": "cancel", "runId": "..." }` |
| The answer of the server | `{ "type": "approval.request", "requestId": "...", "name": "...", "category": "..." }` → `{ "type": "approve", "requestId": "...", "decision": "yes\|no\|always\|abort" }` |
| The question of the server | `{ "type": "question.request", "requestId": "...", "question": "..." }` → `{ "type": "answer", "requestId": "...", "text": "..." }` |
| The events of a run | `{ "type": "run.event", "runId": "...", "event": { "type": "text.delta", ... } }` |
| The end of a run | `{ "type": "run.ended", "runId": "...", "status": "completed\|failed\|cancelled", "exitCode": 0 }` |
| The tools of the processing | `{ "type": "processing.claim", "runId": "...", "tools": [...] }` → `processing.claimed`, `processing.held`, `processing.released` |
| A tool of a client | `{ "type": "tool.request", "requestId": "...", "name": "...", "args": {...} }` → `{ "type": "tool.result", "requestId": "...", "output": "..." }` |

The events of a run are `text.delta`, `text.done`, `reasoning.delta`, `tool.exec.start`,
`tool.exec.done`, `warning`, `error`, `image.saved`, `image.progress`, `response.done`,
`approval.pending`, `question.pending`, `processing.held`, `processing.claimed`,
`processing.released` and `tool.request`.

The list of the fields of the `start` frame is closed: a field the server does not know is
an error, not a silence. `background`, `detach` and `job` are refused by name — a run of
this bus never outlives the socket that started it.

The token is made by the server (`randomBytes(32)`), it is not a flag, and it is written
into `serve.json` with the mode `0600`:

```json
{
  "pid": 12345,
  "url": "ws://127.0.0.1:8765",
  "httpURL": "http://127.0.0.1:8765",
  "token": "<64 hex characters>",
  "protocol": "0.3",
  "startedAt": "2026-11-14T12:00:00.000Z"
}
```

The HTTP part takes the token as `Authorization: Bearer <token>`, as `X-AI-Serve-Token` or
as `?token=`. `/health` is open, the routes under `/v1` are not.

---

## The MCP server

The server speaks JSON-RPC 2.0 over stdio (the default) or over HTTP (`--http`, the route
`/mcp` of the same port and with the same token as the bus). No SDK: the messages are
written by hand, one JSON object per line over stdio.

```bash
ai-serve mcp                 # stdio, for a client of MCP
ai-serve mcp --http --port 8765
```

The methods: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/read`, `prompts/list`, `prompts/get`. The notifications
(`notifications/initialized`, `notifications/cancelled`) are answered silently.

### The tools

| Tool | Category | Risk | What it does |
|---|---|---|---|
| `list_files` | read | low | The files and the directories of a path. The noisy folders are skipped. |
| `read_file` | read | low | A UTF-8 text file, with the numbered lines. |
| `search_files` | read | low | The text files that hold a string or a regular expression. |
| `write_file` | write | medium | Create or overwrite a file. The old version goes to the backup directory. |
| `replace_in_file` | write | medium | Replace a fragment of a file. |
| `delete_file` | write | high | Delete a file. The old version goes to the backup directory. |
| `make_directory` | write | low | Create a directory. |
| `copy_path` | write | medium | Copy a file or a tree. |
| `run_command` | exec | high | One command of the working directory. The output is capped, the command must exit. |
| `run_script` | exec | high | A script file: `.ps1`, `.cmd`, `.bat`, `.sh` or `.bash`. |
| `scan_workspace` | read | low | The map of the workspace: the kind of the project, the aliases, the entry points. |
| `collect_context` | read | low | The card of the workspace, the `AGENTS.md` files, the files of `@path`. |
| `suggest` | read | low | The paths and the commands that fit the context. |

The configuration decides which of them the model sees: `tools.allowWrite: false` hides
every tool of the category `write`, `tools.allowTerminal: false` hides the category `exec`.

---

## The roles of the agent

| Role | What it does | Tools |
|---|---|---|
| `analyzer` | Names the task, the files of it, the risks and the questions. | read |
| `director` | Turns the task into a plan of the work. | read |
| `executor` | Does the steps of the plan with the tools. | all |
| `tooler` | Chooses the one tool that fits the task. | none |
| `suggester` | Answers the question of the user about the project. | read |

The loop of a role asks the model, runs the tools the model asks for and stops when the
model submits the schema of the role or when the limit of the turns is reached
(`limits.maxTurns`).

---

## The outside services

`~/.ai-serve/config.json` holds the outside `ai-serve` instances:

```json
{
  "services": [
    { "name": "other", "url": "ws://127.0.0.1:9000", "token": "<token>" },
    { "name": "worker", "command": "ai-serve", "args": ["serve"], "enabled": true }
  ]
}
```

`~/.ai-serve/mcp.json` holds the outside MCP servers:

```json
{
  "servers": [
    { "name": "files", "command": "node", "args": ["server.js"], "cwd": "/srv/files" },
    { "name": "remote", "url": "https://mcp.example.com", "token": "<token>" }
  ]
}
```

The tools of an outside server are named `server__tool`, so two servers may have a tool
with the same name and the call still goes to the server that owns it. A server that does
not come up does not stop the others: its failure is reported and the rest of the
catalog stays.

`ai-serve services` shows the state of everything: `running`, `stopped`, `configured`,
`disabled` or `error`.

---

## The programmatic API

The package is also a library. The monolith `ai` uses it to raise the server of the bus.

```js
import { startServe, createHub, loadConfig } from '@u2ai/server';

const config = await loadConfig({ cwd: process.cwd() });
const hub = createHub({ token: '<token>' });

const handle = await startServe({
  home: config.home,
  config,
  port: 0,
  hub,
  onComplete: async (frame) => ({ id: frame.id, text: 'the answer' }),
});

console.log(handle.url, handle.httpURL, handle.token);
await handle.close();
```

`startServe` answers with the address of the bus, the address of the HTTP part, the port,
the token, the path of the file with the address and a `close()` that stops everything and
removes the file. It refuses a busy port with the code `PORT_BUSY` and a server that
already runs with the code `ALREADY_RUNNING`.

---

## The development

```bash
npm run check     # parse every file of the package
npm test          # 389 tests
npm pack --dry-run
```

The tests need no key and no network: the model is a stub, the servers listen on
`127.0.0.1` and the home directory of every test is a temporary one.

---

## The license

MIT.
