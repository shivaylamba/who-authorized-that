/**
 * Starts or stops the backend in one of the two startup profiles.
 *
 *   yarn demo:start:gated              # safe/default profile
 *   yarn demo:start:ungated            # lab profile; sets DEMO_LAB_ENABLED=true for this process only
 *   yarn demo:stop
 *
 * Add --foreground to stay attached. The backend serves the built frontend
 * (run `yarn demo:build` once) on http://localhost:7007, bound to 127.0.0.1.
 * Auth signing keys and sessions live in Postgres and survive profile
 * restarts; catalog fixtures are reset separately with `yarn demo:reset`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_URL, ROOT, STATE_DIR, ensureDir, loadEnv, log } from './lib/env';

const pidFile = path.join(STATE_DIR, 'backend.pid');
const logFile = path.join(STATE_DIR, 'backend.log');
const profileFile = path.join(STATE_DIR, 'profile');

function running(): number | undefined {
  if (!fs.existsSync(pidFile)) return undefined;
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function stop() {
  const pid = running();
  if (!pid) {
    log('Backend is not running.');
    return;
  }
  // Kill the whole process group (yarn -> backstage-cli -> node).
  process.kill(-pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(r => setTimeout(r, 300));
    } catch {
      break;
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
  fs.rmSync(pidFile, { force: true });
  log(`Stopped backend (pid ${pid}).`);
}

async function waitReady(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BACKEND_URL}/.backstage/health/v1/readiness`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function start(profile: 'gated' | 'ungated-lab', foreground: boolean) {
  if (running()) {
    throw new Error('Backend already running; run `yarn demo:stop` first (mode changes require a restart).');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ...loadEnv() };
  delete env.DEMO_LAB_ENABLED;
  if (profile === 'ungated-lab') {
    env.DEMO_LAB_ENABLED = 'true';
  }
  const overlay = profile === 'gated' ? 'app-config.gated.yaml' : 'app-config.ungated.yaml';
  const args = [
    'workspace',
    'backend',
    'start',
    '--config',
    path.join(ROOT, 'app-config.yaml'),
    '--config',
    path.join(ROOT, overlay),
  ];
  ensureDir(STATE_DIR);
  fs.writeFileSync(profileFile, profile);
  if (foreground) {
    const child = spawn('yarn', args, { cwd: ROOT, env, stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }
  const out = fs.openSync(logFile, 'a');
  const child = spawn('yarn', args, {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  log(`Starting ${profile} profile (pid ${child.pid}); logs: .demo/backend.log`);
  if (await waitReady(240_000)) {
    log(`Backend ready at ${BACKEND_URL} in ${profile} profile.`);
  } else {
    log('Backend did not become ready within 240 s; check .demo/backend.log');
    process.exitCode = 1;
  }
}

const [cmd] = process.argv.slice(2);
const foreground = process.argv.includes('--foreground');
(async () => {
  if (cmd === 'stop') return stop();
  if (cmd === 'gated' || cmd === 'ungated-lab') return start(cmd, foreground);
  throw new Error(`Unknown command ${cmd}`);
})().catch(e => {
  log(String(e.message ?? e));
  process.exit(1);
});
