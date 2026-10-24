// Extensions: client-side (PWA) modules. Server side only validates and
// serves them; the browser sandbox loads them with dynamic import and hands
// them a registration API scoped by declared permissions.
//
// Serving model: the request names an extension (a registry key lookup — no
// filesystem involvement), and the server responds with that extension's
// entry file, whose absolute path was computed once at load time from
// manifest + directory. Request data never reaches a path or fs call.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fsx.js';

export const EXTENSION_PERMISSIONS = ['ui.cards', 'ui.commands', 'ui.widgets', 'network', 'storage'];

export class ExtensionRegistry {
  constructor({ builtinDir, globalDir, projectDirs = [] } = {}) {
    this.dirs = [builtinDir, globalDir, ...projectDirs].filter(Boolean);
    this.extensions = new Map();
  }

  async load() {
    this.extensions.clear();
    for (const dir of this.dirs) {
      if (!(await exists(dir))) continue;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Containment: the resolved extension dir must stay inside the
        // registry root, or it is not scanned at all.
        const base = path.resolve(dir);
        const edir = path.resolve(base, entry.name);
        if (edir !== base && !edir.startsWith(base + path.sep)) continue;
        let manifest;
        try {
          manifest = JSON.parse(await fsp.readFile(path.join(edir, 'extension.json'), 'utf8'));
        } catch {
          continue; // not a valid extension dir
        }
        const record = {
          name: String(manifest.name ?? entry.name),
          version: String(manifest.version ?? '0.0.0'),
          description: String(manifest.description ?? ''),
          entry: String(manifest.entry ?? 'index.js'),
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions : ['ui.cards'],
          dir: edir,
          source: dir,
          valid: /^[a-z0-9_-]{2,64}$/i.test(String(manifest.name ?? entry.name))
            && manifest.permissions.every((p) => EXTENSION_PERMISSIONS.includes(p)),
        };
        // Absolute path of the servable entry file — computed here, from
        // manifest + directory only. This is the ONLY file served per ext.
        record.entryAbs = path.join(edir, path.basename(record.entry));
        this.extensions.set(record.name, record); // later dirs override
      }
    }
    return this.list();
  }

  list() {
    return [...this.extensions.values()].map((e) => ({
      name: e.name,
      version: e.version,
      description: e.description,
      permissions: e.permissions,
      valid: e.valid,
      url: `/extensions/${encodeURIComponent(e.name)}`,
    }));
  }

  get(name) {
    return this.extensions.get(name) ?? null;
  }

  // Resolve the extension's servable entry file. `name` is only a registry
  // key; the returned path originates entirely from the manifest + directory
  // resolved at load time. Returns null for unknown names.
  async resolveEntry(name) {
    const ext = this.get(String(name ?? ''));
    if (!ext) return null;
    let stat;
    try {
      stat = await fsp.stat(ext.entryAbs);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    return { abs: ext.entryAbs, ext };
  }
}
