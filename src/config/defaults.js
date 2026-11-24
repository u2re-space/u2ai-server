/**
 * Default configuration of the server CLI.
 *
 * Shape mirrors the sibling packages: the same API section (models, backends,
 * fallback), plus the sections this service owns — the bus, the approval mode,
 * the tools it exposes and the external servers it talks to.
 *
 * Every section listed here is also the allow-list for user config files.
 *
 * @ai.hint keep
 */

import { ENUMS } from './constants.js';

export const defaults = {
  // --- API -----------------------------------------------------------------
  /** Text model of the agent roles and of the completion bridge. */
  model: 'minimax/minimax-m3.1-flash',
  /** Endpoint of the text API; backends[] below can override it. */
  baseURL: 'https://routerai.ru/api/v1',
  apiKey: null,
  organization: null,
  project: null,
  /** Send `store: true` on API calls. */
  store: false,
  truncation: 'auto',
  verbosity: null,
  temperature: null,
  maxOutputTokens: null,
  /** Per-model ceilings: { "<model>": { window, maxOutput, ceiling } }. */
  models: {},
  /**
   * The families of models: a named list of interchangeable models, from the cheapest to the
   * most expensive.
   *
   * The run answers with the cheapest member of the family that takes the effort the role
   * asks for, and the rest of the list is the ladder of the budget — the next member answers
   * when the first one refuses.
   */
  modelFamilies: {
    gpt: ['openai/gpt-6.1-terra', 'openai/gpt-6.2-sol'],
    gemini: ['google/gemini-4-hydrogen', 'google/gemini-4-neon'],
    claude: ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5'],
  },  /**
   * The groups of models: a named list of models of one kind — the small and the budget
   * models of the house.
   *
   * The members of a group are peers: the one that fits the work answers. A member may name
   * the limit of the context it is trusted with (`maxContext`, in tokens): the member is not
   * asked when the context of the role is bigger than the limit.
   *
   * A group is named where a model is expected with the prefix `group:`.
   */
  modelGroups: {
    small: [
      { model: 'openai/gpt-6-luna' },
      { model: 'anthropic/claude-haiku-5.5', maxContext: 100_000 },
      { model: 'google/gemini-3.8-flash' },
      { model: 'minimax/minimax-m3.1-flash' },
      { model: 'z-ai/glm-5.3-flashx' },
    ],
  },
  reasoning: { effort: 'medium', summary: 'auto', mode: null },
  retries: 3,
  timeoutMs: 120_000,

  // --- HTTP backends -------------------------------------------------------
  /**
   * Ordered text-API hosts; the first usable one becomes the primary.
   * Entry: { baseURL, apiKey?, env?, headers?, body?, supports? }.
   * `env` is the environment variable name for the key (checked when apiKey
   * is not set).
   */
  backends: [
    { baseURL: 'https://routerai.ru/api/v1', env: 'ROUTERAI_API_KEY' },
    { baseURL: 'https://api.proxyapi.ru/v1', env: 'PROXYAPI_API_KEY' },
    { baseURL: 'https://sprutdock.ru/v1', env: 'SPRUTDOCK_API_KEY' },
    { baseURL: 'https://gptunnel.ru/v1', env: 'GPTUNNEL_API_KEY' },
  ],
  /** Per-model host lists: { "<model>": [{ baseURL, apiKey?, prefix?, vendor?, suffix?, type? }] }. */
  modelsBackends: {},
  /**
   * Model fallback: when a model fails, the next one of the chain answers instead.
   * `models` maps a model to the models to try after it; the key `*` is the chain for every
   * other model.
   *
   * The chain of the house is the Kimi: it answers with the reasoning off in a fraction of the
   * time, so a run that met a refusal keeps going. The Kimi is the fallback of the Gemini and
   * of every other model — the two never stand in the same chain.
   */
  fallback: {
    enabled: true,
    models: {
      'google/gemini-4-hydrogen': ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3', 'openai/gpt-5.1'],
      'minimax/minimax-m3.1-flash': ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3', 'openai/gpt-5.1'],
      '*': ['moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3', 'openai/gpt-5.1'],
    },
  },

  // --- limits ---------------------------------------------------------------
  limits: {
    /** Agent-loop turns per role call. */
    maxTurns: 24,
    /** Retries per API request. */
    requestRetries: 3,
    /** Cap for {{file:...}} substitutions in config strings. */
    maxFileReadBytes: 256 * 1024,
    /** Cap of a file the tools may write. */
    maxWriteBytes: 4 * 1024 * 1024,
    /** Cap of the output a command tool returns. */
    maxOutputBytes: 64 * 1024,
    /** Wall-clock budget of one command. */
    commandTimeoutMs: 180_000,
    /** Largest accepted WebSocket frame. */
    maxFrameBytes: 1024 * 1024,
    /** Largest accepted body of an HTTP request. */
    maxBodyBytes: 8 * 1024 * 1024,
  },

  // --- tools ----------------------------------------------------------------
  /**
   * The tools the service exposes over MCP and to the agent.
   * `read` covers listing and reading, `write` covers every change of the disk,
   * `terminal` runs commands, `workspace` scans the project, `suggest` proposes
   * paths and commands.
   */
  tools: {
    read: true,
    write: true,
    list: true,
    search: true,
    terminal: true,
    workspace: true,
    suggest: true,
    /** Read the installed Agent Skills. */
    skills: true,
    /** Hand a bounded task to a sub-agent: a separate thread or process. */
    subagent: true,
    /** The eye of the service: shoot the page of the working directory. */
    browser: true,
    /** Let the tools write; when false the service is read-only. */
    allowWrite: true,
    /** Let the tools run commands; when false the terminal is off. */
    allowTerminal: true,
  },

  // --- browser ---------------------------------------------------------------
  /**
   * The browser of the service: the engine that opens the page of the working directory.
   *
   * Ego Lite (`ego`) is the engine of the house when it is installed. Otherwise the
   * service falls back to headless Chrome/Edge, which is read-only: it opens a page and takes
   * a picture of it.
   */
  browser: {
    /** `auto` prefers Ego Lite, `ego` demands it, `chrome` demands a headless Chromium. */
    engine: 'auto',
    /** The path of the browser, when the usual places do not hold it. */
    executable: null,
    /** How long one call of the browser may take, in milliseconds. */
    timeoutMs: 45_000,
    /** The frame of the picture of the page: the width and the height in pixels. */
    viewport: { width: 1440, height: 900 },
  },

  // --- server ---------------------------------------------------------------
  /** The bus and the HTTP bridge. */
  server: {
    /** The interface to listen on. Only 127.0.0.1 until the remote stage. */
    host: '127.0.0.1',
    /** The port; 0 picks a free one. */
    port: 0,
    /** How much the server asks before it runs a tool: ask | read | write | all. */
    approve: 'ask',
    /** Write serve.json into the home directory. */
    writeServeFile: true,
    /** Seconds a client may stay silent before the socket closes. */
    idleTimeoutMs: 90_000,
    /** Seconds between pings. */
    pingIntervalMs: 30_000,
  },

  // --- completion -----------------------------------------------------------
  /** The tab-autocomplete bridge. */
  completion: {
    /** Answer completion requests. */
    enabled: true,
    /** Extra tokens the bridge accepts beside the serve token. */
    tokens: [],
    /**
     * The model of the completion.
     *
     * A completion is a small action: the insertion of a few characters. The group of the
     * small models answers it — the cheapest model that fits the work.
     */
    model: 'group:small',
    /** The reasoning effort of the completion. */
    effort: 'low',
  },

  // --- MCP ------------------------------------------------------------------
  /**
   * The MCP server we run: the tools of this package, published to other agents.
   */
  mcp: {
    /** Run the MCP server next to the bus. */
    enabled: true,
    /** The transport of the MCP server: stdio | http. */
    transport: 'stdio',
    /** The port of the HTTP transport. */
    port: 0,
    /** Publish the tool list on initialize. */
    listTools: true,
  },
  /**
   * External MCP servers we call as clients. Each entry is either
   * `{ name, url }` for an HTTP server or `{ name, command, args }` for a server
   * started over stdio. The list lives in ~/.ai-serve/mcp.json.
   *
   * Entry: { name, url?, token?, command?, args?, env?, cwd?, enabled?, timeoutMs? }.
   * The proxy names the tools of a server `server__tool`, so two servers may have a tool
   * with the same name. The list starts empty: the servers of the user are his own.
   */
  mcpServers: [],

  // --- services -------------------------------------------------------------
  /**
   * External services we keep connected: other `ai-serve` instances.
   * Entry: { name, url, token }.
   */
  services: [],

  // --- the house of the run ----------------------------------------------------
  /**
   * The house of the run: the ranks of the models of the house in their families.
   *
   * A path is a list of the places of a family: the role answers on the first place and
   * steps down to the next one when its work is done. The path belongs to the role: the
   * stages inherit it.
   */
  house: {
    ranks: { roles: {} },
  },

  // --- roles ----------------------------------------------------------------
  /**
   * Per-role overrides. Model/effort resolution chain:
   * role -> roles.default -> top level. `instructions` are appended to the
   * role prompt; `tools` limits the tools of that role.
   */
  roles: {
    default: { model: null, effort: null, summary: null, maxEffort: null, context: null, temperature: null, maxOutputTokens: null, instructions: null, tools: null },
    analyzer: {},
    director: {},
    executor: {},
    tooler: {},
    // The suggester answers questions about the project: a small action, a cheap model.
    suggester: { model: 'group:small' },
  },

  /** Extra named roles merged into the role registry at load. */
  customRoles: {},

  // --- skills ----------------------------------------------------------------
  /** Output root for role skills (read-only skill packs per role). */
  skills: { dir: null },
};

/** Allowed fields of one `roles.<name>` entry (null = inherited). */
export const ROLE_FIELDS = Object.freeze([
  'model', 'effort', 'summary', 'maxEffort', 'context', 'temperature',
  'maxOutputTokens', 'instructions', 'tools',
]);

export function cloneDefaults() {
  return structuredClone(defaults);
}

/**
 * Starter file written to ~/.ai-serve/config.json on first run: only the
 * fields a user is expected to edit; everything else stays on the defaults.
 */
export function defaultConfigText() {
  const starter = {
    model: defaults.model,
    reasoning: { effort: defaults.reasoning.effort, summary: defaults.reasoning.summary },
    backends: structuredClone(defaults.backends),
    server: {
      host: defaults.server.host,
      port: defaults.server.port,
      approve: defaults.server.approve,
    },
    tools: {
      allowWrite: defaults.tools.allowWrite,
      allowTerminal: defaults.tools.allowTerminal,
    },
    completion: {
      enabled: defaults.completion.enabled,
      model: defaults.completion.model,
    },
    modelFamilies: structuredClone(defaults.modelFamilies),
    modelGroups: structuredClone(defaults.modelGroups),
    mcp: {
      enabled: defaults.mcp.enabled,
      transport: defaults.mcp.transport,
    },
    mcpServers: structuredClone(defaults.mcpServers),
  };
  return `${JSON.stringify(starter, null, 2)}\n`;
}

/** The enums the validator needs; re-exported here to keep the import graph flat. */
export { ENUMS };
