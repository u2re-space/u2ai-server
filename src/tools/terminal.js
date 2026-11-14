/**
 * @file src/tools/terminal.js
 * @module tools/terminal
 * @purpose Spawn a shell command with a timeout, a capped output, and a secret-stripped
 *          environment.
 *
 *   The terminal is the sharpest tool of the package: it runs what the model writes. Three
 *   rules keep it from becoming a hole:
 *
 *   1. the working directory is the root of the run, and a relative path never leaves it;
 *   2. the child sees no variable whose name looks like a secret;
 *   3. the output is capped, and the process tree dies when the time is up.
 *
 *   The command never throws: a failed command is an answer, not a crash. The result says
 *   what happened — the exit code, the output, and the flags `timedOut` and `cancelled`.
 *
 * @depends node:child_process, node:path, agent/access
 * @usedBy tools/tools, tools/file-commands, agent/roles
 * @exports SHELLS, childEnvironment, scriptLaunch, runCommand, runProgram
 * @ai.tags terminal, shell, process
 * @ai.hint io
 * @ai.hint legacy-0.2
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveInside } from '../agent/access.js';

/** The shells a model may name on a single call. Empty means the platform default. */
export const SHELLS = Object.freeze(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']);

/** The longest a command may run, in milliseconds. */
export const MAX_COMMAND_TIMEOUT_MS = 900_000;

/** The names of the variables that never reach a child process. */
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/**
 * The environment of a child process: everything except the variables that look like a
 * secret, plus the two flags that keep the output quiet and the tools non-interactive.
 * @param {Record<string, string|undefined>} [env]
 * @returns {Record<string, string>}
 * @exports
 * @ai.hint pure
 */
export function childEnvironment(env = process.env) {
    const result = {};
    for (const [key, value] of Object.entries(env)) {
        if (SECRET_ENV.test(key)) continue;
        if (value === undefined) continue;
        result[key] = value;
    }
    result.CI = result.CI ?? '1';
    result.NO_COLOR = '1';
    return result;
}

/**
 * The executable and the arguments of `command` for the named shell.
 * @param {string} command
 * @param {string|null} shell
 * @returns {{ file: string, args: string[], verbatim?: boolean }}
 * @ai.hint pure
 */
function shellCommand(command, shell) {
    const win = process.platform === 'win32';
    switch (shell) {
        case 'powershell':
        case 'pwsh':
            return {
                file: shell === 'pwsh' ? 'pwsh' : 'powershell',
                args: ['-NoProfile', '-NonInteractive', '-Command', command],
            };
        case 'cmd':
            // The same quoting Node uses for shell:true on Windows: /s strips the outer quotes.
            return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
        case 'bash':
        case 'sh':
        case 'zsh':
            return { file: shell, args: ['-c', command] };
        default:
            return win
                ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
                : { file: '/bin/sh', args: ['-c', command] };
    }
}

/**
 * Kill a child and the processes it started.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {void}
 * @ai.hint io
 */
function killTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        // taskkill must see the parent alive to enumerate its tree; the shell dies afterwards.
        const fallback = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
        try {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            killer.once('error', fallback);
            killer.once('close', fallback);
        } catch { fallback(); }
        return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * The interpreter of a script file: `.ps1` → PowerShell, `.cmd`/`.bat` → cmd, `.sh`/`.bash` → bash.
 * An explicit shell overrides the extension. The arguments are argv, not a shell string.
 * @param {string} absPath the absolute path of the script
 * @param {{ shell?: string|null, args?: string[] }} [options]
 * @returns {{ file: string, args: string[] }}
 * @exports
 * @ai.hint pure
 */
export function scriptLaunch(absPath, { shell = null, args = [] } = {}) {
    const ext = path.extname(absPath).toLowerCase();
    const chosen = shell || (
        ext === '.ps1' ? 'powershell'
            : ext === '.cmd' || ext === '.bat' ? 'cmd'
                : ext === '.sh' || ext === '.bash' ? 'bash'
                    : null
    );
    if (!chosen || !SHELLS.includes(chosen)) {
        throw new Error('The shell must be one of: powershell, pwsh, cmd, bash, sh, zsh.');
    }
    const extra = args.map((item) => String(item));
    if (chosen === 'powershell' || chosen === 'pwsh') {
        return {
            file: chosen === 'pwsh' ? 'pwsh' : 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', absPath, ...extra],
        };
    }
    if (chosen === 'cmd') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', absPath, ...extra] };
    return { file: chosen, args: [absPath, ...extra] };
}

/**
 * Run one command in the working directory.
 *
 * The result never throws: a failure is an answer with `exitCode` and `error`.
 * @param {{ command: string, cwd?: string, root?: string, timeoutMs?: number,
 *           maxOutputBytes?: number, signal?: AbortSignal, shell?: string|null }} options
 * @returns {Promise<{ exitCode: number|null, signal: string|null, stdout: string, stderr: string,
 *           timedOut: boolean, cancelled: boolean, truncated: boolean, durationMs: number,
 *           error: string|null }>}
 * @exports
 * @ai.hint io
 */
export function runCommand({
    command,
    cwd,
    root,
    timeoutMs = 180_000,
    maxOutputBytes = 64 * 1024,
    signal,
    shell = null,
} = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('The command must be a non-empty string.');
    const launched = shellCommand(command, shell);
    return runProgram({ ...launched, cwd, root, timeoutMs, maxOutputBytes, signal });
}

/**
 * Spawn an executable with an argv list.
 *
 * The working directory is resolved through `agent/access`, so a relative path of the model
 * cannot leave the root of the run.
 * @param {{ file: string, args?: string[], cwd?: string, root?: string, input?: Buffer|string|null,
 *           timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal, verbatim?: boolean }} options
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function runProgram({
    file,
    args = [],
    cwd,
    root,
    input = null,
    timeoutMs = 180_000,
    maxOutputBytes = 64 * 1024,
    signal,
    verbatim = false,
} = {}) {
    if (typeof file !== 'string' || !file.trim()) throw new Error('The program must be a non-empty string.');
    const limit = Math.max(1, Math.min(Number(maxOutputBytes) || 64 * 1024, 8 * 1024 * 1024));
    const budget = Math.max(1, Math.min(Number(timeoutMs) || 180_000, MAX_COMMAND_TIMEOUT_MS));

    // The working directory of the child is inside the root of the run.
    let workdir = root ? path.resolve(root) : process.cwd();
    if (cwd) {
        if (root) {
            const inside = await resolveInside(root, cwd);
            workdir = inside.abs;
        } else {
            workdir = path.resolve(workdir, cwd);
        }
    }

    const started = Date.now();
    return new Promise((resolve) => {
        let child;
        const output = { stdout: [], stderr: [] };
        let captured = 0;
        let truncated = false;
        let timedOut = false;
        let cancelled = false;
        let finished = false;
        let spawnError = null;

        /**
         * Keep stdout or stderr until the limit, then mark the output as cut.
         * @param {'stdout'|'stderr'} stream
         * @param {Buffer} chunk
         * @returns {void}
         * @ai.hint pure
         */
        const consume = (stream, chunk) => {
            const room = Math.max(0, limit - captured);
            const slice = chunk.subarray(0, room);
            if (slice.length) {
                output[stream].push(slice);
                captured += slice.length;
            }
            if (slice.length < chunk.length) truncated = true;
        };

        /**
         * Resolve once, with the captured output and the flags of the run.
         * @param {number|null} code
         * @param {string|null} sig
         * @returns {void}
         * @ai.hint pure
         */
        const finish = (code, sig) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            // A surviving grandchild must not keep our pipes (and the event loop) alive.
            child?.stdout?.destroy();
            child?.stderr?.destroy();
            resolve({
                exitCode: code,
                signal: sig ?? null,
                timedOut,
                cancelled,
                truncated,
                durationMs: Date.now() - started,
                stdout: Buffer.concat(output.stdout).toString('utf8'),
                stderr: Buffer.concat(output.stderr).toString('utf8'),
                error: spawnError?.message ?? null,
            });
        };

        /** Kill the tree and give it a moment to die before the answer is sent. */
        const stop = () => {
            killTree(child);
            setTimeout(() => finish(null, 'SIGKILL'), 1500).unref();
        };

        /** The caller aborted the run. */
        const onAbort = () => { cancelled = true; stop(); };

        const timer = setTimeout(() => { timedOut = true; stop(); }, budget);

        try {
            child = spawn(file, args, {
                cwd: workdir,
                env: childEnvironment(),
                stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                windowsHide: true,
                windowsVerbatimArguments: Boolean(verbatim),
                detached: process.platform !== 'win32',
            });
            if (input != null) {
                child.stdin.on('error', () => { });
                child.stdin.end(input);
            }
        } catch (error) {
            spawnError = error;
            finish(null, null);
            return;
        }

        child.stdout.on('data', (chunk) => consume('stdout', chunk));
        child.stderr.on('data', (chunk) => consume('stderr', chunk));
        child.once('error', (error) => { spawnError = error; finish(null, null); });
        child.once('close', (code, sig) => finish(code, sig));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}
