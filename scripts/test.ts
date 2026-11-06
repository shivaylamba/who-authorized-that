/**
 * Runs the relevant automated suite:
 *   1. TypeScript type check
 *   2. Unit and service tests (jest via backstage-cli)
 *   3. Live acceptance suite against the running backend's current profile
 *
 *   yarn demo:test            # all three
 *   yarn demo:test --no-live  # 1 and 2 only (no running backend needed)
 */
import { spawnSync } from 'node:child_process';
import { ROOT, log } from './lib/env';

const steps: Array<[string, string, string[]]> = [
  ['type check', 'yarn', ['tsc']],
  ['unit + service tests', 'yarn', ['backstage-cli', 'repo', 'test', '--ci', 'plugins/']],
];
if (!process.argv.includes('--no-live')) {
  steps.push(['live acceptance (current profile)', 'yarn', ['demo:test:e2e']]);
}

let failed = false;
for (const [name, cmd, args] of steps) {
  log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  if (r.status !== 0) {
    failed = true;
    log(`=== ${name}: FAILED (exit ${r.status}) ===`);
  }
}
process.exit(failed ? 1 : 0);
