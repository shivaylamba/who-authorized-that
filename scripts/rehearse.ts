/**
 * Full timed rehearsal of the stage sequence with deterministic replay:
 *
 *   1. ungated lab: start, reset, replay
 *   2. gated: restart, reset, replay, direct replay of the denied call
 *   3. act 3 (gated): agent account under a MIG-42 task grant vs. Alice
 *   4. compare
 *
 *   yarn demo:rehearse
 *
 * Writes evidence/rehearsal-<timestamp>.json with step timings. Leaves the
 * backend running in the gated profile with fixtures reset.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { EVIDENCE_DIR, ROOT, log, writeJson } from './lib/env';
import { resetFixtures } from './lib/operator';
import { runAgentReplay, runReplay } from './replay';

const timings: Array<{ step: string; ms: number; ok: boolean }> = [];

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  log(`\n--- ${name}`);
  try {
    const r = await fn();
    timings.push({ step: name, ms: Date.now() - t0, ok: true });
    return r;
  } catch (e) {
    timings.push({ step: name, ms: Date.now() - t0, ok: false });
    throw e;
  }
}

function yarn(args: string[]) {
  const r = spawnSync('yarn', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`yarn ${args.join(' ')} failed`);
}

async function main() {
  const started = Date.now();
  await step('stop backend', () => yarn(['demo:stop']));
  await step('start ungated lab', () => yarn(['demo:start:ungated']));
  await step('reset fixtures', () => resetFixtures('rehearsal'));
  const ungated = await step('ungated replay', () =>
    runReplay({ instance: 'alice', direct: false, endpointPath: '/api/mcp-actions/v1', label: 'rehearsal:ungated-lab' }),
  );
  await step('reset fixtures', () => resetFixtures('rehearsal'));
  await step('stop backend', () => yarn(['demo:stop']));
  await step('start gated', () => yarn(['demo:start:gated']));
  await step('reset fixtures', () => resetFixtures('rehearsal'));
  const gated = await step('gated replay', () =>
    runReplay({ instance: 'alice', direct: false, endpointPath: '/api/mcp-actions/v1', label: 'rehearsal:gated' }),
  );
  const direct = await step('gated direct replay of the denied call', () =>
    runReplay({ instance: 'alice', direct: true, endpointPath: '/api/mcp-actions/v1', label: 'rehearsal:gated:direct' }),
  );
  await step('reset fixtures', () => resetFixtures('rehearsal'));
  const agentAct = await step('act 3: agent identity + task grant', () =>
    runAgentReplay({ label: 'rehearsal:agent-act3:gated' }),
  );
  await step('compare', () => yarn(['demo:compare']));
  await step('reset fixtures for the next rehearsal', () => resetFixtures('ready'));

  const totalMs = Date.now() - started;
  const report = {
    ranAt: new Date().toISOString(),
    totalMs,
    targetMs: 5 * 60 * 1000,
    verdicts: {
      ungated: ungated.verdict,
      gated: gated.verdict,
      direct: direct.verdict,
      agentAct: agentAct.verdict,
    },
    timings,
  };
  const file = path.join(EVIDENCE_DIR, `rehearsal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJson(file, report);
  log('\nStep timings:');
  for (const t of timings) log(`  ${(t.ms / 1000).toFixed(1).padStart(6)} s  ${t.ok ? '' : 'FAILED '}${t.step}`);
  log(`Total ${(totalMs / 1000).toFixed(1)} s (target under 300 s on a warmed-up machine). Verdicts: ${JSON.stringify(report.verdicts)}`);
  if (Object.values(report.verdicts).some(v => v !== 'PASS')) process.exitCode = 1;
}

main().catch(e => {
  log(String(e.stack ?? e));
  process.exit(1);
});
