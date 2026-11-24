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
| The tools (`src/tools/*`) | The catalog of the agent: the filesystem, the terminal, the map of the workspace, the suggestions, the eye (the screenshot of the page), the hand-over to a sub-agent. |
| The roles (`src/roles/*`) | The loop of the agent: the analyzer, the director, the executor, the tooler, the suggester. |
| The sub-agents (`src/agent/subagent.js`) | The hand-over of a bounded task to a separate worker — a thread or a process — that inherits the role, the tools, the rights and the API data of the run. |
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
| `ai-serve skills [--json]` | The list of the installed Agent Skills of the project and the user. |
| `ai-serve agent "<task>" [--cwd dir] [--role name]` | A one-off task as an AI agent. Without a role the agent analyzes, plans and does the work. |
| `ai-serve complete --file <path> --line <n>` | A one-off completion for the file and the line. The answer is the text to insert. |
| `ai-serve services [list\|add\|add-mcp\|remove]` | The outside services: their state, their addresses, their tokens. |
| `ai-serve config` | The resolved configuration, with the secrets shortened. |
| `ai-serve doctor` | The check of the environment: Node.js, the home directory, the configuration, the key, the port, the services. |

The exit codes are `0` (done), `1` (a failure), `2` (a usage error) and `130` (interrupted).

### The shell of the service

In a terminal, `ai-serve` opens the graphical dashboard of the house: the commands of the
service, the addresses it listens on, the live log of the runs and the operator line. The
service itself is the internal worker `ai-serve-worker`: it owns the ordinary stdout and
stderr and talks to the shell over a versioned IPC protocol.

```bash
ai-serve serve            # the dashboard of the running service
ai-serve serve --headless # the worker alone: the machine output stays the same
ai-serve serve --json     # one json object per line on stdout
```

The events of the runs are shown in the dashboard as they happen: the tools the agent calls,
the answers of the model, the questions and the warnings. The signal of the shell reaches the
worker, so the service does not stay alive when the shell that started it is gone.

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
| `~/.ai-serve/tmp/` | The state of the runs: one directory per run. |
| `~/.ai-serve/serve.json` | The address of the running server. Written by the server, mode `0600`, removed when the server stops. |

The layout of the home is described in one place — `homeLayout()` in `src/config/paths.js` — and
every path of it has its own function: `homeConfigFile`, `homeMcpFile`, `homeSkillsDir`,
`homeLogsDir`, `homeTmpDir`, `homeRunDir`, `serveFile`. Nothing guesses where a file of the
service lies.

### The contract of `serve.json`

The file is the address of the running server. A client reads it, checks the pid, and
connects. The old fields are still there — a client of the version 0.2 keeps working — and
the new ones name the parts of the server:

| Field | What it is |
|---|---|
| `pid` | The process of the server. A client checks it before it connects. |
| `url` | The WebSocket of the bus: `ws://127.0.0.1:<port>`. |
| `token` | The secret of the server. The client sends it in the `hello` frame. |
| `httpURL` | The root of the HTTP part. |
| `complete` | The route of the completion: `<httpURL>/v1/complete`. |
| `structure` | The route of the structure: `<httpURL>/v1/structure`. |
| `completeWs` | The WebSocket of the completion: `<url>/v1/complete`. |
| `mcp` | The endpoint of the MCP server: `<httpURL>/mcp`, or `null` when there is none. |
| `protocol` | The version of the protocol of the bus. |
| `startedAt` | When the server started. |

---

## The house of the project

The home of the service is the state of the service. The house of a project is the state of the
work: every project has one directory of its own, `.ai/`, and everything a run makes that is not
the product itself lives there, and nowhere else.

```
.ai/
  tmp/<run-id>/     the state of the run: what it was, what it changed
  assets/           the assets of the house
  logs/             the logs of the house
  manifest.json     the contract of the project: what every system made and where it lies
```

The state of a run dies with the run: a new run never reads the state of the old one. The
`ai-serve agent` command and every run of the bus leave the state of the run in
`.ai/tmp/<run-id>/run.json`.

The product stays where the user expects it — the files the agent writes stay in the project —
and the house keeps the state and the contract.

The contract is how the systems of the house find each other: the webdev, the measurer, the
decomposer, the images and the server sign the same file, and every system owns its own part of
it. The server signs the files its run wrote:

```json
{
  "manifestVersion": 1,
  "updatedAt": "2026-11-15T03:41:02.113Z",
  "systems": {
    "server": {
      "delivery": ".",
      "artifacts": {
        "changes": ["src/app.js", "README.md"]
      },
      "updatedAt": "2026-11-15T03:40:58.002Z"
    }
  }
}
```

The paths are relative to the project and with forward slashes: the contract is read on another
machine and another system, and the path has to mean the same thing there. A system that cannot
sign the contract warns and goes on — the contract is a hint, not a reason to fail.

The files of the house are written whole: the bytes go to a file next to the target and the
target is replaced by a rename. A reader never sees half of a file, and a run that dies in the
middle leaves the old file and not a broken one. The write of the tools and the write of the
access layer are atomic too.

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
  "tools": { "allowWrite": true, "allowTerminal": true, "browser": true },
  "browser": { "engine": "auto", "viewport": { "width": 1440, "height": 900 } },
  "completion": { "enabled": true, "model": "group:small" },
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

### The models of the house

The profiles of the text models are tuned by the cards of the gateway (RouterAI, November 2026)
and by the live answers of it. The window and the output cap of the house are the same for every
model — the context of the agent is bounded by the service, not by the card of the model:

| Model | Window | Output | Ceiling | Ladder |
|---|---|---|---|---|
| `minimax/minimax-m3.1-flash` | 256K | 32K | `high` | `low`, `medium`, `high` |
| `google/gemini-4-hydrogen` | 256K | 32K | `xhigh` | `low`, `medium`, `high`, `xhigh` |
| `moonshotai/kimi-k3.1-pro` | 256K | 32K | `medium` | `none`, `low`, `medium` |

The Gemini 4 Hydrogen is the alternative to the Kimi: it takes the effort up to `xhigh`, so a
role that has to think hard is not cut short. The card of the vendor names the four levels of
its effort and has no `none`, so the reasoning off is raised to `low`. The Kimi K3.1 Pro takes
the reasoning off without a refusal and answers in a fraction of the time, so `none` stays on
its ladder — the levels above `medium` cost the same seconds, and `medium` is its ceiling.

When a model refuses, the next one of the chain answers instead. The chain of the house is the
Kimi: it is the fallback of the Gemini and of every other model — the two never stand in the
same chain.

```json
{
  "fallback": {
    "enabled": true,
    "models": {
      "google/gemini-4-hydrogen": ["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3", "openai/gpt-5.1"],
      "minimax/minimax-m3.1-flash": ["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3", "openai/gpt-5.1"],
      "*": ["moonshotai/kimi-k3.1-pro", "moonshotai/kimi-k3", "openai/gpt-5.1"]
    }
  }
}
```

The key `*` is the chain of every model that has no chain of its own. `fallback.enabled: false`
turns the chain off.

### The families and the groups of models

A model may be named in the configuration by a family of models or by a group of them.

A family is a named list of interchangeable models, from the cheapest to the most expensive.
The run answers with the cheapest member of the family that takes the effort of the role, and
the rest of the list is the ladder of the budget: when the model of the family refuses, the
next member answers in its place.

```json
{
  "modelFamilies": {
    "gpt": ["openai/gpt-6.1-terra", "openai/gpt-6.2-sol"],
    "gemini": ["google/gemini-4-hydrogen", "google/gemini-4-neon"],
    "claude": ["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5"]
  }
}
```

A group is a named list of models of one kind — the small and the budget models of the house.
The members of a group are peers: the one that fits the work answers. A member may name the
limit of the context it is trusted with (`maxContext`, in tokens): the member is not asked when
the context of the role is bigger than the limit.

```json
{
  "modelGroups": {
    "small": [
      { "model": "openai/gpt-6-luna" },
      { "model": "anthropic/claude-haiku-5.5", "maxContext": 100000 },
      { "model": "google/gemini-3.8-flash" },
      { "model": "minimax/minimax-m3.1-flash" },
      { "model": "z-ai/glm-5.3-flashx" }
    ]
  }
}
```

A family is named with the prefix `family:` and a group with the prefix `group:` — in the
model of the run, in the model of a role, in the model of the completion:

```json
{
  "model": "minimax/minimax-m3.1-flash",
  "completion": { "model": "group:small" },
  "roles": { "suggester": { "model": "group:small" } }
}
```

The small actions of the service answer on the group of the small models: the tab-completion
of the editor and the role `suggester` are two of them. The other members of the group are the
peers of the one that answered: when the model of the group refuses, the next member of the
group answers in its place.

The list of a family is also a ranking: a path of the ranks says where in its family a role
answers — the first place of the path, and the next one when its work is done:

```json
{
  "house": {
    "ranks": { "roles": { "suggester": [1, 0] } }
  }
}
```

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

The bus is a stream of JSON texts over a WebSocket. The version of the protocol is `0.4`;
the client sends it in the `hello` frame.

| Moment | Frame |
|---|---|
| The greeting | client → `{ "type": "hello", "role": "client", "token": "<token>", "name": "vscode" }`; the server answers `{ "type": "ready", "runs": [...] }`. |
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
| The tools of a client | `{ "type": "tools.register", "tools": [{ "name": "read_file", "description": "...", "parameters": {...} }] }` → `tools.registered` |
| A tool of the catalog of a client | server → `{ "type": "tool.call", "requestId": "...", "name": "read_file", "arguments": {...} }` → `{ "type": "tool.result", "requestId": "...", "output": "..." }` |

### The tools of the clients

A client may publish the tools of its own — the file system of the editor, the terminal of
the editor. The names of the tools carry the name of the client, so two clients may have a
tool with the same name: the tool `read_file` of the client `vscode` is `vscode__read_file`.

The server keeps the catalog of every client, and the MCP server publishes it. A client
that is gone takes its tools with it.

The VSCode extension is such a client: it publishes the tools of the workspace of the
editor — the files, the search, the terminal — and the server calls them back with the
frame `tool.call`. Any other AI system may take them through the MCP server of the
package, and the extension may serve them over stdio on its own.

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
  "complete": "http://127.0.0.1:8765/v1/complete",
  "structure": "http://127.0.0.1:8765/v1/structure",
  "completeWs": "ws://127.0.0.1:8765/v1/complete",
  "mcp": "http://127.0.0.1:8765/mcp",
  "token": "<64 hex characters>",
  "protocol": "0.4",
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

### The data URLs of a message

A message that carries a picture as text carries it twice: once as the base64 and once as the
words around it. Nobody reads the base64 — the model sees a wall of characters, the request
grows by a third of the picture for nothing, and some gateways refuse such a message
altogether.

So every data URL is cut out of the text of a message and the payload goes into the request as
what it is: `data:image/png;base64,…` becomes an image part, `data:application/pdf;base64,…`
becomes a file part (`file_data` in base64), `data:text/plain,…` becomes a text part. In the
text itself a short note takes the place of the data URL:

```
The picture of the reference: [picture attached: image/png, 12.4 KB]
```

**The name of the caller is a claim, the bytes are the fact.** The house looks at the payload
before it decides what it is: a picture that came as `application/octet-stream` is a picture,
a JSON that came as a blob is text, and a binary that came as `text/plain` is a file. When the
name and the content differ, the note names both:

```
[picture attached: application/octet-stream → image/png, 317.8 KB]
```

The cut happens in the answer of a tool and in the builder of the request — the last one is the
safety net: every text that leaves the server is cut there, whatever path it took. The words
of a message without a data URL are not touched.

### The tools

| Tool | Category | Risk | What it does |
|---|---|---|---|
| `list_files` | read | low | The files and the directories of a path. The noisy folders are skipped. |
| `read_file` | read | low | A UTF-8 text file, with the numbered lines. |
| `search_files` | read | low | The text files that hold a string or a regular expression. The paths of the files are matched too (`inContent=false`), and a glob (`*.scss`, `src/**/*.js`) cuts the files by their name. |
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
| `screenshot` | read | low | A screenshot of the page of the working directory, taken in a real browser. |

The configuration decides which of them the model sees: `tools.allowWrite: false` hides
every tool of the category `write`, `tools.allowTerminal: false` hides the category `exec`,
`tools.browser: false` hides the eye, and `tools.skills: false` hides `read_skill`.

### The eye of the service

The editor sees the code; the page is another thing. The tool `screenshot` opens the page of
the working directory in a real browser and takes a picture of it, so the agent can look at
what it has written — the layout, the proportions, the type — instead of guessing from the
CSS. The picture is written under `.ai/shots/`, and the answer names the file.

The project is served by a local server of the package: a `file://` URL breaks the modules and
the fetch of a modern project, so no server has to be running for the call.

Two engines are supported: **headless Chrome/Edge**, which is read-only, is on every desktop and
takes the snapshot by default; and **Ego Lite** (`ego`), the engine of the house with the window
and the interaction, used when it is asked for explicitly (`browser.engine: "ego"`).

The tool speaks to the browser over the Chrome DevTools Protocol, so the answer holds the
picture **and** what the page says about itself: the console, the exceptions and the failed
requests (404, 500). A failed request names the file that is missing, an exception names the line
that broke. The `url` argument points the browser at a live address — the dev server of the
project (`http://localhost:5173/`) shows the styles as they are now.

```json
{
  "browser": {
    "engine": "auto",
    "executable": null,
    "timeoutMs": 45000,
    "viewport": { "width": 1440, "height": 900 }
  }
}
```

### The tools of the clients

The bus may have clients: an editor that published its tools with `tools.register`. The
MCP server shows those tools in the same list and calls them on the owner of the tool.

The names carry the name of the client, so two clients may have a tool with the same
name: the tool `read_file` of the client `vscode` is `vscode__read_file`. The tool of
the package keeps its own name, and the tool of a client is called with the name the
client published, not with the name of the list.

```json
{ "name": "vscode__read_file", "description": "Read a file of the workspace.",
  "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } } } }
```

The same list is in the route `/v1/tools` of the HTTP part: the tools of the clients are
there with the category `client`.

---

## The Agent Skills

`ai-serve` discovers standard Agent Skills in the project (`.agents/skills`, `.koda/skills`,
`.claude/skills`, `.rules/skills`) and in the global user directory (`~/.agents/skills`).
The catalogue is given to the roles and to the agent behind the bus, and the model opens a
skill with the `read_skill` tool when the task fits it.

```bash
npx skills add heydamir/unslop -g
npx skills add felipebasurto/unslop-ui -g
npx skills add oil-oil/oil-ui -g
npx skills add GoogleChrome/modern-web-guidance -g
npx modern-web-guidance@latest install

ai-serve skills
ai-serve skills --json
```

The MCP server publishes the catalogue as the resource `ai-serve://skills` and exposes
`read_skill` as an ordinary MCP tool.

Role-specific packs live in `~/.ai-serve/skills` (or in `skills.dir` from the configuration).
A file named after a role belongs to that role; `shared.md` belongs to every role. A directory
with a `SKILL.md` may declare its roles in the frontmatter:

```markdown
---
name: House style
description: The conventions of this project.
roles: analyzer, director, executor
---
```

The text of a role pack is appended to the instructions of the role. The packs are read, never
written.

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

## The agent behind the bus

The bus carries the runs of the clients. The agent of the package answers them:

| Command | What it does | Tools |
|---|---|---|
| `ask` | Answers the question of the client. | none |
| `run` | Does the work of the client with the tools. | the catalog of the configuration |
| `chat` | Keeps the thread of the conversation until the client stops it. | the catalog of the configuration |
| `image` | Answers with a warning: the package has no image generator. | none |

The tools of the model go through the hub: a client that holds a tool runs it itself, and
the server runs the tools that nobody holds. Every step of the work is published to the
bus as an event, so the editor sees the life of the run:

| Event | What it carries |
|---|---|
| `text.delta` | A piece of the answer of the model. |
| `reasoning.delta` | A piece of the thinking of the model. |
| `tool.exec.start` | The tool the model asks for. |
| `tool.exec.done` | The answer of the tool: `ok`, `summary`, `changes`. |
| `subagent.start` | A sub-agent starts: the role it inherits and the task of the hand-over. |
| `subagent.status` | The state of a sub-agent: the turn and the status of the worker. |
| `subagent.done` | The report of a sub-agent: the turns, whether the files were verified. |
| `text.done` | The whole answer. |
| `response.done` | The usage of the tokens and the model that answered. |
| `warning`, `error` | What went wrong. |

The agent is also a library:

```js
import { createHub, createServerAgent } from '@u2ai/server';

const hub = createHub({ token: '<token>', onStart: (run, frame) => agent.start(run, frame) });
const agent = createServerAgent({ hub, config, root: process.cwd() });
```

---

## The hand-over to a sub-agent

A run of the bus meets work that is one bounded piece of another kind — a wide search, a
scan, a second opinion on a plan. That piece does not belong in the conversation of the
run: it eats the context of the model and buries the thread of the work. The model hands
it over with the tool `subagent`:

```json
{ "role": "executor", "task": "Search every page for a link to the old host and write
the list into links.md.", "files": ["links.md"] }
```

The work goes to a **sub-agent**: a separate worker — a thread of the server process by
default, or a child process of its own with `transport: "process"` — that starts with a
clean conversation, its own instructions and its own budget of turns. The sub-agent
carries no role of its own:

| Inherited | From where |
|---|---|
| The role | The call: `analyzer` (a look), `director` (a plan), `executor` (the hands). |
| The tools | The role's mode (`read` or `all`), cut by the tools of the run; the hand-over tool itself is never inherited. |
| The rights | The working directory of the run; the files it writes are written by the tools of the server. |
| The API data | The endpoint, the key and the model of the run; a named `model`, `effort` or `apiKey` in the call wins. |
| The skills | The same catalogue of the installed Agent Skills. |

The tools of the sub-agent go through the **same hub**: a client that holds a tool runs
it for the sub-agent too, the approval is asked the same way, and the events land in the
same run — the editor sees the hand-over as it sees a tool. The big texts of the
hand-over (the instructions of the role) travel in shared memory when the transport is a
thread: one `SharedArrayBuffer` the parent writes and the thread reads, with the flag of
cancellation inside it. The hand-over is one level deep: a sub-agent never hands work
over itself.

The flag `tools.subagent: false` turns the hand-over off: the tool disappears from the
catalogue and the run does its work in one conversation.

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

## The access layer

The access is the door between the model and the machine: the files and the commands under
one root. Both halves work through a backend, so the same rules hold on a native disk, in
the memory, or over a remote one.

```js
import { createAccess } from '@u2ai/server';

const access = createAccess({ root: process.cwd() });

await access.fs.writeText('notes/todo.md', '# todo');
const read = await access.fs.readText('notes/todo.md');
const found = await access.fs.search({ query: 'todo' });

const listing = await access.fs.listFiles('src', { depth: 2, limit: 400 });
const copied = await access.fs.copy('src/app.js', 'lib/app.js');

const answer = await access.exec.run('node', ['--version']);
```

The rules of the paths live in one place and are never optional: a path may not leave the
root — neither through `..` nor through a symbolic link — the secret files and the secret
directories are never accessible, and the read-only directories may be read, but never
written.

`listFiles` returns the tree of a path as the model reads it: the noisy folders are marked
and not opened, the dot-files are hidden unless they are asked for, the sizes are in the
text, and a path that does not exist yet answers with the nearest existing parent.
`copy` copies a file or a tree under the same rules: no secret, no symbolic link, no
directory into itself, and the destination must not exist unless `overwrite` is asked for.

The default backend is Node.js: `node:fs/promises` and `node:child_process`. Another one
may be put in its place:

```js
import { createAccess } from '@u2ai/server';
import { createMemoryBackend } from '@u2ai/server/src/access/memory.js';

const backend = createMemoryBackend();
const access = createAccess({ root: '/work', fs: backend.fs, exec: backend.exec });
```

The backend of the files answers `readFile`, `writeFile`, `readdir`, `stat`, `lstat`,
`realpath`, `unlink`, `mkdir`, `rename` and `copy`; the backend of the commands answers
`run`. The state of a path is a plain object with the properties (`isDirectory`, `isFile`,
`isSymbolicLink`), not the methods of Node.js: every backend answers in one shape.

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
npm test          # 463 tests
npm pack --dry-run
```

The tests need no key and no network: the model is a stub, the servers listen on
`127.0.0.1` and the home directory of every test is a temporary one. The suite is also
guarded: `test/offline-guard.js` refuses every address outside the machine, so a test that
reaches the outside fails fast instead of spending money.

---

## The license

MIT.
