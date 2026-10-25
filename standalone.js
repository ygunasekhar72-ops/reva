// REVA standalone entry — runs the ENTIRE harness inside an embedded Node.js
// runtime (nodejs-mobile) on the Android device. No external server needed.
//
// Launched by NodeRunner as: node <filesDir>/nodejs-project/standalone.js
// All paths derive from this script's own location (code origin), so nothing
// attacker- or argv-supplied ever reaches a path decision:
//   <filesDir>/nodejs-project/  ← this file's directory (read-only copy)
//   <filesDir>/                 ← home: keystore, accounts, global config
//   <filesDir>/workspace/       ← the agent's on-device workspace
//
// HOME is set BEFORE any REVA module is imported (ESM top-level imports
// hoist, so every REVA import here is dynamic).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const home = path.resolve(projectDir, '..');
const workspace = path.join(home, 'workspace');
process.env.HOME = home;
process.env.USERPROFILE = home; // parity for os.homedir() on any platform
process.env.REVA_STANDALONE = '1';

const { createHarness } = await import('./src/core/harness.js');
const { RevaServer } = await import('./src/server/index.js');

const harness = await createHarness({ workspace });
await harness.loadPlugins();

// Standalone posture: the embedded server runs on the device itself, owned by
// the device user — local shell access is the point of this mode. Provider
// keys still live in the encrypted keystore; the UI still requires login
// (the user creates their own admin on first launch).
harness.config.data.tools.exec.enabled_over_server = true;
harness.config.data.server.host = '127.0.0.1';
harness.config.data.server.port = 7463;
harness.config.data.server.allow_anonymous_local = false;
harness.startScheduler();

const server = new RevaServer({ harness, host: '127.0.0.1', port: 7463 });
await server.listen();

console.log(`REVA standalone: http://127.0.0.1:${server.actualPort} (workspace ${workspace})`);
