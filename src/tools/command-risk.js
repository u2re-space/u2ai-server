/**
 * @file src/tools/command-risk.js
 * @module tools/command-risk
 * @purpose Hold back a command request that reads like intrusion, then send a plain
 *          local-task wording.
 *
 *   The check is about the wording, not about the command itself: an ordinary install,
 *   build, or test command goes through unchanged. A request that asks for a script *and*
 *   reads like an attack is rewritten into a plain local-task sentence before it reaches
 *   the model, so the model never receives the attack-shaped text at all.
 *
 * @usedBy tools/tools, agent/roles
 * @exports assessCommandRisk, rewriteCommandText, guardCommandInput
 * @ai.tags prompt, safety
 * @ai.hint pure
 * @ai.hint legacy-0.2
 */

/** The text asks for a script or a command. */
const SHELL = /\b(?:bash|cmd(?:\.exe)?|powershell|pwsh|zsh|\.sh|\.bat|\.cmd|\.ps1|shell(?:\s+script)?|scripts?|run_command|run_script)\b|скрипт|команд[аыуе]/i;

/** The text asks the model to write or to prepare something. */
const ASK = /(?:напиш|сгенер|создай|сделай|подготов|составь|generate|write|create|compose|produce|draft|prepare)\w*/i;

/** The wordings that look like an attack. */
const RISKS = [
    { re: /эксплойт|exploit|payload|reverse shell|bind shell|полезн\w* нагрузк/i, reason: 'it reads like an attack scenario' },
    { re: /взлом|взломать|hack(?:ing|er)?|проникн|брутфорс|brute[- ]force/i, reason: 'it reads like a break-in' },
    { re: /украсть парол|слить парол|credential dump|steal (?:the )?password|keylog|кейлог|дамп учет|дамп учёт/i, reason: 'it asks for someone else’s credentials' },
    { re: /вредонос|malware|ransomware|шифровальщик|троян|backdoor|бэкдор/i, reason: 'it reads like a malicious scenario' },
    { re: /обход защит|bypass (?:auth|antivirus|defender)|отключ\w* защитник|disable defender/i, reason: 'it reads like a bypass of a protection' },
];

/** The replacement: an ordinary local task. */
const PLAIN = 'Continue the local project task. Write only ordinary commands for install, build, test, or the dev server, and keep them inside this project.';

/**
 * Whether the text asks for a command and also reads like intrusion.
 * @param {string} text
 * @returns {{ action: 'send'|'rewrite', reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function assessCommandRisk(text) {
    const value = String(text ?? '');
    if (!SHELL.test(value) || !ASK.test(value)) return { action: 'send', reasons: [] };
    const reasons = [...new Set(RISKS.filter((item) => item.re.test(value)).map((item) => item.reason))];
    if (!reasons.length) return { action: 'send', reasons: [] };
    return { action: 'rewrite', reasons };
}

/**
 * Drop the attack-shaped sentences from a script request. The replacement never repeats them.
 * @param {string} text
 * @returns {{ text: string, action: 'send'|'rewrite', reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function rewriteCommandText(text) {
    const verdict = assessCommandRisk(text);
    if (verdict.action !== 'rewrite') return { text: String(text ?? ''), ...verdict };
    const kept = String(text)
        .split(/(?<=[.!?\n])\s+/)
        .map((part) => part.trim())
        .filter((part) => part && !RISKS.some((item) => item.re.test(part)));
    const body = kept.join(' ').trim();
    return {
        action: 'rewrite',
        reasons: verdict.reasons,
        text: body ? `${body}\n${PLAIN}` : PLAIN,
    };
}

/**
 * Rewrite the message text of an outbound request. The tool calls stay intact.
 * @param {object[]} items
 * @returns {{ changed: boolean, reasons: string[] }}
 * @exports
 * @ai.hint pure
 */
export function guardCommandInput(items) {
    const reasons = [];
    let changed = false;
    for (const item of items ?? []) {
        if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (!part || typeof part.text !== 'string') continue;
            const next = rewriteCommandText(part.text);
            if (next.action !== 'rewrite' || next.text === part.text) continue;
            part.text = next.text;
            changed = true;
            reasons.push(...next.reasons);
        }
    }
    return { changed, reasons: [...new Set(reasons)] };
}
