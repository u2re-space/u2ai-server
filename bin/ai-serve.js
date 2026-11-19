#!/usr/bin/env node
/**
 * @file bin/ai-serve.js
 * @module bin/ai-serve
 * @purpose Process entry of the graphical ai-serve command.
 *
 *   A terminal gets the dashboard of the house: the commands of the service, the addresses
 *   it listens on, the live log and the operator line. A pipe, a redirect, `--json` and
 *   `--quiet` use the worker directly, so automation and the bridges do not have to know
 *   about the terminal interface.
 * @depends tui/cli
 * @usedBy package bin
 * @ai.tags cli, tui
 * @ai.hint io
 */
import { mainTui } from '../src/tui/cli.js';

// A crash that happened outside the command keeps its own exit code: the command may
// have returned 0 before the process fell over.
process.exitCode = (await mainTui(process.argv.slice(2))) || process.exitCode || 0;
