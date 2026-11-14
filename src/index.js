/**
 * @file src/index.js
 * @module index
 * @purpose Barrel re-export: everything the CLI and the public API use.
 * @ai.hint keep
 */

export { main, EXIT } from './cli.js';
export { parseArgv } from './cli/parser.js';
export { HELP, COMMAND_NAMES } from './help.js';
export { COLORS, paint } from './cli/colors.js';
export { checkNodeVersion, REQUIRED_NODE } from './cli/compatibility.js';
