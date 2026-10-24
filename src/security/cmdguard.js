// Command guard for the exec tool. Two layers:
//  1. BLOCK list — never executed, regardless of mode (destructive system ops).
//  2. AUDIT list — flagged as dangerous; requires confirmation or an explicit
//     policy override, and is always written to the audit log.
// Note: this is defense-in-depth for an interactive agent, not a sandbox. The
// exec tool additionally runs under the OS user; container/Termux users should
// treat workspace scope as the boundary.

const BLOCK_PATTERNS = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\/(\s|$)/i, why: 'rm targeting filesystem root' },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+~|\brm\s+-[a-zA-Z]*f?[a-zA-Z]*r\b.*(\s|["'`])~?\/?\s*$/i, why: 'rm -rf of home/root' },
  { re: /\bmkfs(\.\w+)?\b/i, why: 'mkfs formats a filesystem' },
  { re: /\b(fdisk|parted|diskpart)\b/i, why: 'disk partitioning tool' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'system power control' },
  { re: /:\(\)\s*\{.*\};\s*:/s, why: 'fork bomb pattern' },
  { re: /\b(REG\s+DELETE|reg\s+delete)\b.*\/f/i, why: 'force registry delete' },
  { re: /\b(Format-Volume|Remove-Item\s+[^\n]*-Recurse\s+[^\n]*-Force\s+[^\n]*C:\\)\b/i, why: 'destructive PowerShell against system drive' },
  { re: /\bdd\s+([^\n]*\bof=\/dev\/(sd|nvme|disk|mmcblk))/i, why: 'dd writing to a raw device' },
  { re: /\b(chmod|chown)\s+(-\w+\s+)?777\s+\/(\s|$)/, why: 'chmod 777 on filesystem root' },
  { re: />\s*\/dev\/sd[a-z]/i, why: 'raw device overwrite' },
];

const AUDIT_PATTERNS = [
  { re: /\brm\b/, why: 'deletes files' },
  { re: /\bgit\s+push\b/, why: 'publishes to a remote' },
  { re: /\bnpm\s+(install|i|publish)\b/, why: 'installs/publishes packages' },
  { re: /\bpip\s+install\b/, why: 'installs packages' },
  { re: /\bcurl\b.*\|\s*(ba)?sh\b/, why: 'pipes downloads into a shell' },
  { re: /\bwget\b.*\|\s*(ba)?sh\b/, why: 'pipes downloads into a shell' },
  { re: /\bsudo\b/, why: 'elevates privileges' },
  { re: /\bkill(all)?\b/, why: 'kills processes' },
  { re: /\bmv\b\s+[^\n]*\s+\/dev\//, why: 'moves onto a device node' },
  { re: /\beval\b/, why: 'evaluates a string as code' },
  { re: /[|;&]\s*\$\(/, why: 'command substitution inside a pipeline' },
  { re: /`[^`]+`/, why: 'backtick command substitution' },
  { re: /\$\([^)]*\)/, why: 'command substitution' },
  { re: /\bnc\b|\bnetcat\b/, why: 'raw network tool' },
  { re: /\bssh\b/, why: 'remote shell' },
  { re: /\bat\b\s+\d|\bcrontab\b/, why: 'schedules system jobs' },
];

export class CommandGuardError extends Error {
  constructor(message, { kind, patterns, command }) {
    super(message);
    this.code = kind === 'block' ? 'ECMDBLOCK' : 'ECMDAUDIT';
    this.kind = kind;
    this.patterns = patterns;
    this.command = command;
    this.status = 403;
  }
}

export function inspectCommand(command) {
  const cmd = String(command ?? '');
  const blocked = [];
  for (const p of BLOCK_PATTERNS) {
    if (p.re.test(cmd)) blocked.push(p.why);
  }
  if (blocked.length > 0) {
    throw new CommandGuardError(`command refused: ${blocked.join('; ')}`, {
      kind: 'block', patterns: blocked, command: cmd,
    });
  }
  const flagged = [];
  for (const p of AUDIT_PATTERNS) {
    if (p.re.test(cmd)) flagged.push(p.why);
  }
  return { dangerous: flagged.length > 0, reasons: flagged };
}

// mode:
//  'block'   → flagged commands are refused outright (no confirmation escapes)
//  'confirm' → flagged commands require confirmed=true (default; the agent
//              surfaces the flag to the user and re-runs on approval)
//  'strict'  → same as block
// The BLOCK list refuses in every mode regardless.
export function guardCommand(command, { mode = 'confirm', confirmed = false } = {}) {
  const result = inspectCommand(command); // throws on block-list
  if (!result.dangerous) return result;
  if (mode === 'block' || mode === 'strict') {
    throw new CommandGuardError(
      `command refused by policy (${result.reasons.join('; ')})`,
      { kind: 'audit', patterns: result.reasons, command: String(command) },
    );
  }
  if (mode === 'confirm' && !confirmed) {
    throw new CommandGuardError(
      `command is dangerous (${result.reasons.join('; ')}) and requires confirmation`,
      { kind: 'audit', patterns: result.reasons, command: String(command) },
    );
  }
  return result;
}
