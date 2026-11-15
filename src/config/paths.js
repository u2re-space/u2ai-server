/**
 * Home directory and config file locations.
 *
 * The service keeps its state in ~/.ai-serve (override with AI_SERVE_HOME).
 * The home has one layout, and `homeLayout` describes all of it at once:
 *
 *   - config.json — the configuration;
 *   - mcp.json — the external MCP servers;
 *   - serve.json — the address of the running server;
 *   - skills/ — the skill packs of the roles;
 *   - logs/ — the logs of the service;
 *   - tmp/<run-id>/ — the state of the runs.
 *
 * The home of the service is not the house of a project: the house of a project is
 * `.ai/` inside the project, and its law lives in `shared/house`.
 *
 * @ai.hint keep
 */

import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Agent home directory: AI_SERVE_HOME, or ~/.ai-serve.
 * @param {object} [env]
 * @returns {string}
 */
export function defaultHome(env = process.env) {
  return env.AI_SERVE_HOME ? path.resolve(env.AI_SERVE_HOME) : path.join(os.homedir(), '.ai-serve');
}

/**
 * Absolute path of the home config file.
 * @param {string} home
 * @returns {string}
 */
export function homeConfigFile(home) {
  return path.join(home, 'config.json');
}

/**
 * Absolute path of the file with the external MCP servers.
 * @param {string} home
 * @returns {string}
 */
export function homeMcpFile(home) {
  return path.join(home, 'mcp.json');
}

/**
 * Absolute path of the home skill directory.
 * @param {string} home
 * @returns {string}
 */
export function homeSkillsDir(home) {
  return path.join(home, 'skills');
}

/**
 * Absolute path of the home log directory.
 * @param {string} home
 * @returns {string}
 */
export function homeLogsDir(home) {
  return path.join(home, 'logs');
}

/**
 * Absolute path of the serve.json file: the address of the running server.
 * @param {string} home
 * @returns {string}
 */
export function serveFile(home) {
  return path.join(home, 'serve.json');
}

/**
 * Absolute path of the home directory of the state of the runs.
 * @param {string} home
 * @returns {string}
 */
export function homeTmpDir(home) {
  return path.join(home, 'tmp');
}

/**
 * Absolute path of the state of one run: `<home>/tmp/<run-id>/`.
 *
 * The id is cleaned before it becomes a name of a directory: the id of a run comes
 * from the outside, and a directory is not a place for a strange name.
 * @param {string} home
 * @param {string} [runId]
 * @returns {string}
 */
export function homeRunDir(home, runId = '') {
  const id = String(runId ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64);
  const base = homeTmpDir(home);
  return id ? path.join(base, id) : base;
}

/**
 * The whole home of the service in one object: every path of the layout at once.
 *
 * The home is described in one place, so a caller never guesses where a file of the
 * service lies.
 * @param {string} home
 * @returns {{ root: string, config: string, mcp: string, serve: string, skills: string,
 *            logs: string, tmp: string }}
 */
export function homeLayout(home) {
  const root = path.resolve(String(home ?? '.'));
  return {
    root,
    config: homeConfigFile(root),
    mcp: homeMcpFile(root),
    serve: serveFile(root),
    skills: homeSkillsDir(root),
    logs: homeLogsDir(root),
    tmp: homeTmpDir(root),
  };
}

/**
 * Resolve a --config argument to an absolute path.
 * @param {string|null|undefined} configPath
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveConfigPath(configPath, cwd = process.cwd()) {
  if (!configPath || typeof configPath !== 'string' || !configPath.trim()) return null;
  return path.resolve(cwd, configPath.trim());
}

/**
 * Create the home directory when missing (best effort: a read-only home
 * must not break a run that works entirely from flags).
 * @param {string} home
 * @returns {Promise<void>}
 */
export async function ensureHomeDir(home) {
  try {
    await mkdir(home, { recursive: true });
  } catch { /* ignore */ }
}
