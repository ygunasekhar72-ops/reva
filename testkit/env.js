// Test environment isolation: redirect the "global home" (~/.reva) into a
// temp dir BEFORE anything computes it, and provide workspace factories.
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

export function isolateHome(t) {
  const home = path.join(os.tmpdir(), `reva-test-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  if (t) {
    t.after(async () => {
      restoreHome(saved, home);
    });
  }
  return saved;
}

// Swap into a fresh home now; caller restores via restoreHome(saved, null).
export function pushHome() {
  const home = path.join(os.tmpdir(), `reva-test-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  saved.__home = home;
  return saved;
}

export function restoreHome(saved, home) {
  process.env.USERPROFILE = saved.USERPROFILE;
  process.env.HOME = saved.HOME;
  const target = home ?? saved.__home;
  if (target) fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}

export async function makeWorkspace(name = 'ws') {
  const dir = path.join(os.tmpdir(), `reva-test-ws-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(path.join(dir, '.reva'), { recursive: true });
  return dir;
}

export async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}
