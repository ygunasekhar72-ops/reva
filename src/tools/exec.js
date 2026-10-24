// exec tool: run a shell command inside the workspace. Guarded by the command
// guard (block/audit lists), hard timeout, and output caps.
import { spawn } from 'node:child_process';
import { guardCommand, CommandGuardError } from '../security/cmdguard.js';

export const execTool = {
  name: 'exec',
  description: 'Run a shell command in the project workspace. Use for builds, git, tests, and CLI tools. Relative paths resolve to the workspace root. Dangerous commands require confirmation.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 30000, max 300000)' },
      confirmed: { type: 'boolean', description: 'Set true to confirm a flagged dangerous command' },
    },
    required: ['command'],
  },
  dangerous: true,

  async execute(args, ctx) {
    const cfg = ctx.config?.get('tools.exec') ?? {};
    if (ctx.mode === 'server' && cfg.enabled_over_server !== true) {
      throw new Error('exec tool is disabled over the network server (tools.exec.enabled_over_server=false). Enable it in project config if you accept the risk.');
    }
    if (cfg.enabled === false) throw new Error('exec tool is disabled in config (tools.exec.enabled=false)');

    const command = String(args.command ?? '');
    if (command.length > 20000) throw new Error('command too long');

    const mode = cfg.dangerous_mode ?? 'confirm';
    let guardResult;
    try {
      guardResult = guardCommand(command, { mode, confirmed: args.confirmed === true });
    } catch (err) {
      if (err instanceof CommandGuardError && err.kind === 'audit') {
        ctx.emit?.({ type: 'tool_confirm_needed', tool: 'exec', command, reasons: err.patterns });
        throw new Error(`CONFIRMATION REQUIRED: this command is flagged (${err.patterns.join('; ')}). Re-run with confirmed=true if the user approved it.`);
      }
      throw err;
    }
    if (guardResult?.dangerous && ctx.audit) {
      await ctx.audit.record(ctx.session?.actor ?? 'agent', 'tool.dangerous', { tool: 'exec', command, reasons: guardResult.reasons });
    }

    const timeoutMs = Math.min(300000, Math.max(250, args.timeout_ms ?? cfg.timeout_ms ?? 30000));
    const maxOut = cfg.max_output_bytes ?? 200000;

    return runShell(command, {
      cwd: ctx.workspace,
      timeoutMs,
      maxOut,
      env: safeEnv(),
      signal: ctx.signal,
    });
  },
};

function safeEnv() {
  const env = { ...process.env };
  // Never leak configured provider keys into child processes.
  for (const key of Object.keys(env)) {
    if (/API_KEY|APIKEY|SECRET|TOKEN|PASSWORD/i.test(key)) {
      delete env[key];
    }
  }
  env.REVA_WORKSPACE = '1';
  return env;
}

export function runShell(command, { cwd, timeoutMs = 30000, maxOut = 200000, env = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    // Fixed system shells only — never an env-var-chosen binary (a caller-
    // controlled ComSpec would be an untrusted program selection).
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
    let child;
    try {
      child = spawn(shell, shellArgs, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // On Windows, spawn with shell args array; detaching not needed.
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      truncated = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (stdout.length < maxOut) stdout += d;
      else truncated = true;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxOut) stderr += d;
      else truncated = true;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signalKilled) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = [
        stdout.length > 0 ? stdout : '',
        stderr.length > 0 ? `--- stderr ---\n${stderr}` : '',
      ].filter(Boolean).join('\n');
      const text = [
        out || '(no output)',
        truncated ? `\n[output truncated at ${maxOut} bytes / timeout ${timeoutMs}ms]` : '',
        code === 0 ? '' : `\n[exit code: ${code}${signalKilled ? ` signal: ${signalKilled}` : ''}]`,
      ].filter(Boolean).join('');
      resolve({
        text,
        exit_code: code,
        truncated,
        timed_out: truncated && signalKilled !== null,
      });
    });
  });
}
