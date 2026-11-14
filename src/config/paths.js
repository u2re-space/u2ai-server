/**
 * Home directory and config file locations.
 *
 * The service keeps its state in ~/.ai-serve (override with AI_SERVE_HOME):
 * config.json is the configuration, mcp.json lists the external MCP servers,
 * the skill packs live in ~/.ai-serve/skills and the logs in ~/.ai-serve/logs.
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
