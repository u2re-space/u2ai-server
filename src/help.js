/**
 * @file src/help.js
 * @module help
 * @purpose The help text of the CLI. English, because the CLI speaks to every project.
 * @exports HELP, COMMAND_NAMES
 * @ai.hint keep
 */

/** The commands the CLI answers to. */
export const COMMAND_NAMES = Object.freeze([
    'serve',
    'mcp',
    'tools',
    'agent',
    'complete',
    'services',
    'config',
    'doctor',
]);

/**
 * The help text.
 * @type {string}
 * @exports
 * @ai.hint pure
 */
export const HELP = `ai-serve — an MCP server with tools, a bus for editor extensions, and a completion bridge.

Usage:
  ai-serve <command> [options]

Commands:
  serve                Run the bus, the HTTP bridge and the MCP server. Writes serve.json.
  mcp                  Run the MCP server only: stdio by default, HTTP with --http.
  tools                List the tools of the package (name, category, risk).
  agent <task>         Run a one-off task as an AI agent.
  complete             Print a one-off completion for a file and a line.
  services             List the external services (ai-serve and MCP) and their state.
  config               Print the resolved configuration.
  doctor               Check the environment: Node, config, keys, port, services.

Options:
      --port <n>       The port to listen on (default: a free port).
      --cwd <dir>      The working directory of the task.
      --role <name>    The role of the agent: analyzer, director, executor, tooler, suggester.
      --http           The MCP server speaks HTTP instead of stdio.
      --stdio          The MCP server speaks stdio (default).
  -c, --config <file>   The config file to use.
      --json           Print the result as JSON.
  -h, --help           Print this text.
  -v, --version        Print the version.

The home directory is ~/.ai-serve: config.json, mcp.json, skills/, logs/.
The environment prefix is AI_SERVE_*; OPENAI_* and AI_MODEL are read as well.
`;
