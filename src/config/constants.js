/**
 * Allowed values and shared literals of the configuration system.
 *
 * These enums are the contract between the parser, the validator and the
 * server: a config value outside them is a user error and fails the load.
 *
 * The service answers as `minimax/minimax-m3.1-flash` by default: the server
 * is a light tool host, not a heavy reasoner.
 *
 * @ai.hint keep
 */

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** Env prefix of this CLI (the monolith uses AI_*, ours is namespaced). */
export const ENV_PREFIX = 'AI_SERVE_';

export const ENUMS = Object.freeze({
  reasoningEfforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  reasoningSummaries: Object.freeze(['auto', 'concise', 'detailed']),
  reasoningModes: Object.freeze(['off', 'priority']),
  /** Word context levels; resolved to bytes by the model profile at load time. */
  contextLevels: Object.freeze({ small: 16 * KiB, normal: 96 * KiB, large: 512 * KiB, max: 8 * MiB }),
  contextWords: Object.freeze(['auto', 'small', 'normal', 'large', 'max']),
  /** Backend entries may declare which API routes the host serves. */
  backendRoutes: Object.freeze(['responses', 'chat']),
  /** How much the server asks before it runs a tool. */
  approveModes: Object.freeze(['ask', 'read', 'write', 'all']),
  /** What a tool touches; the category decides whether the server asks. */
  toolCategories: Object.freeze(['read', 'write', 'terminal', 'workspace']),
  /** Transports of the MCP server we run ourselves. */
  mcpTransports: Object.freeze(['stdio', 'http']),
  /** Roles of the server agent. */
  roles: Object.freeze(['analyzer', 'director', 'executor', 'tooler', 'suggestor']),
  /** Shells the terminal tool may use. */
  shells: Object.freeze(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']),
});

/** Role names that always exist; user roles are validated against the schema only. */
export const BUILTIN_ROLE_NAMES = Object.freeze([
  'default', 'analyzer', 'director', 'executor', 'tooler', 'suggestor',
]);

/** Alias spellings accepted in backend `supports` maps. */
export const SUPPORT_ALIASES = Object.freeze({
  responseapi: 'responses', responses: 'responses',
  chatapi: 'chat', chat: 'chat', chatcompletions: 'chat', completions: 'chat',
});

/** RFC 7230 token characters for header names in backend entries. */
export const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
