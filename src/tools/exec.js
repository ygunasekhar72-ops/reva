// exec tool: run a shell command inside the workspace. Guarded by the command
// guard (block/audit lists), hard timeout, and output caps.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
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

// Kill the whole process tree, not just the shell: `/bin/sh -c "sleep 300 &"` or
// `cmd /c npm run dev` leave descendants alive after a plain signal to the shell.
// POSIX: the shell was spawned detached (its own process group) → signal -pid.
// Windows: a fixed helper script runs `taskkill /T`; the OS-assigned pid is
// passed through the environment, so no variable reaches an argument list.
const TREE_KILL_HELPER = `
// Fixed-content REVA helper: kills a process tree by pid (from env).
const pid = Number(process.env.REVA_TREE_PID);
if (Number.isInteger(pid) && pid > 0) {
  require('child_process').spawn(
    'taskkill', ['/pid', String(pid), '/T', '/F'],
    { stdio: 'ignore', windowsHide: true },
  ).unref();
}
`;

let treeKillHelperPath = null;

function windowsTreeKill(pid) {
  if (!treeKillHelperPath) {
    treeKillHelperPath = path.join(os.tmpdir(), `reva-tree-kill-${process.pid}.js`);
    fsSync.writeFileSync(treeKillHelperPath, TREE_KILL_HELPER, { mode: 0o600 });
  }
  spawn(process.execPath, [treeKillHelperPath], {
    env: { ...process.env, REVA_TREE_PID: String(pid) },
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) return; // OS-assigned, never user input
  if (process.platform === 'win32') {
    try {
      windowsTreeKill(pid);
    } catch { /* process already gone */ }
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // negative pid = process group
    } catch {
      try { child.kill('SIGKILL'); } catch { /* process already gone */ }
    }
  }
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
        // POSIX only: the shell becomes a process-group leader so the whole
        // tree can be signalled at once (killTree). Windows uses taskkill /T.
        detached: !isWin,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let killedByUs = false;

    const killMine = () => {
      killedByUs = true;
      killTree(child);
    };

    const timer = setTimeout(() => {
      truncated = true;
      killMine();
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      killMine();
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
        // Deterministic: we know we killed it, regardless of how the platform
        // reports the termination (Windows taskkill yields code 1, no signal).
        timed_out: truncated && killedByUs,
      });
    });
  });
}
