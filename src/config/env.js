/**
 * Configuration fields taken from the environment.
 *
 * Precedence inside the CLI: defaults < config.json < --config file < env <
 * CLI overrides. This module only maps env names to config paths; merging is
 * the loader's job. `AI_SERVE_*` is the primary namespace; the plain
 * `OPENAI_*` / `AI_*` names are accepted for compatibility with the
 * monolith's user setup.
 *
 * @ai.hint keep
 */

import { ENUMS } from './constants.js';

/**
 * Parse one env value as a bounded integer.
 * @param {string|undefined} raw
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function intInRange(raw, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/**
 * Parse one env value as a JSON array of backend entries; invalid input is ignored.
 * @param {string|undefined} raw
 * @returns {object[]|null}
 */
function backendList(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Build a partial config object from environment variables.
 * @param {object} [env]
 * @returns {object}
 */
export function fromEnv(env = process.env) {
  const out = {};
  const set = (path, value) => {
    if (value === undefined || value === null || value === '') return;
    let owner = out;
    for (const step of path.slice(0, -1)) {
      owner[step] ??= {};
      owner = owner[step];
    }
    owner[path.at(-1)] = value;
  };

  // --- API -----------------------------------------------------------------
  set(['model'], env.AI_SERVE_MODEL ?? env.AI_MODEL ?? env.OPENAI_MODEL);
  set(['baseURL'], env.AI_SERVE_BASE_URL ?? env.OPENAI_BASE_URL);
  set(['apiKey'], env.AI_SERVE_API_KEY ?? env.OPENAI_API_KEY);
  set(['organization'], env.OPENAI_ORG_ID);
  set(['project'], env.OPENAI_PROJECT_ID);

  // --- reasoning ------------------------------------------------------------
  if (ENUMS.reasoningEfforts.includes(env.AI_SERVE_EFFORT)) set(['reasoning', 'effort'], env.AI_SERVE_EFFORT);

  // --- HTTP plumbing --------------------------------------------------------
  const retries = intInRange(env.AI_SERVE_RETRIES, 0, 10);
  if (retries != null) set(['retries'], retries);
  const timeoutMs = intInRange(env.AI_SERVE_TIMEOUT_MS, 5_000, 600_000);
  if (timeoutMs != null) set(['timeoutMs'], timeoutMs);
  const maxTurns = intInRange(env.AI_SERVE_MAX_TURNS, 1, 200);
  if (maxTurns != null) set(['limits', 'maxTurns'], maxTurns);

  // --- backends -------------------------------------------------------------
  const backends = backendList(env.AI_SERVE_BACKENDS);
  if (backends) set(['backends'], backends);

  // --- server ---------------------------------------------------------------
  const port = intInRange(env.AI_SERVE_PORT, 0, 65535);
  if (port != null) set(['server', 'port'], port);
  if (env.AI_SERVE_HOST) set(['server', 'host'], env.AI_SERVE_HOST);
  if (ENUMS.approveModes.includes(env.AI_SERVE_APPROVE)) set(['server', 'approve'], env.AI_SERVE_APPROVE);

  // --- completion -----------------------------------------------------------
  if (env.AI_SERVE_COMPLETION === '0' || env.AI_SERVE_COMPLETION === 'false') set(['completion', 'enabled'], false);
  if (env.AI_SERVE_COMPLETION === '1' || env.AI_SERVE_COMPLETION === 'true') set(['completion', 'enabled'], true);

  // --- MCP ------------------------------------------------------------------
  if (env.AI_SERVE_MCP === '0' || env.AI_SERVE_MCP === 'false') set(['mcp', 'enabled'], false);
  if (env.AI_SERVE_MCP === '1' || env.AI_SERVE_MCP === 'true') set(['mcp', 'enabled'], true);
  if (ENUMS.mcpTransports.includes(env.AI_SERVE_MCP_TRANSPORT)) set(['mcp', 'transport'], env.AI_SERVE_MCP_TRANSPORT);

  return out;
}

/**
 * The config file named by the environment, if any.
 * @param {object} [env]
 * @returns {string|null}
 */
export function envConfigPath(env = process.env) {
  return env.AI_SERVE_CONFIG || null;
}
