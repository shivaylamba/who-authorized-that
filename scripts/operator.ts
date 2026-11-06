/**
 * Operator-only commands. None of these are MCP tools or web buttons.
 *
 *   yarn demo:seed                       register any missing manifest targets + approvals
 *   yarn demo:reset [--label x]          end the active run, restore manifest targets, start a new run
 *   yarn demo:export <runId|latest>      write sanitized JSON evidence to evidence/
 *   yarn demo:wipe-evidence --yes        delete historical demo evidence (separate, explicit)
 *   tsx scripts/operator.ts health       operator health view
 */
import path from 'node:path';
import { EVIDENCE_DIR, log, writeJson } from './lib/env';
import type { ResetResult } from './lib/types';
import { exportRun, getHealth, operator, resetFixtures } from './lib/operator';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'seed': {
      const r = await operator<ResetResult>('POST', '/operator/seed', {});
      log(`Seed: registered [${r.registered.join(', ')}], already present [${r.alreadyPresent.join(', ')}]`);
      if (r.missingAfterWait.length) {
        log(`WARNING: still missing after 30 s: ${r.missingAfterWait.join(', ')}`);
        process.exitCode = 1;
      }
      log(`Active run: ${r.activeRun?.runId} (${r.activeRun?.mode})`);
      return;
    }
    case 'reset': {
      const r = await resetFixtures(flag('--label'));
      log(
        `Reset in ${r.durationMs} ms: registered [${r.registered.join(', ')}], already present [${r.alreadyPresent.join(', ')}]`,
      );
      if (r.missingAfterWait.length) {
        log(`WARNING: still missing: ${r.missingAfterWait.join(', ')}`);
        process.exitCode = 1;
      }
      log(`New active run: ${r.activeRun.runId} (${r.activeRun.mode})`);
      return;
    }
    case 'health': {
      log(JSON.stringify(await getHealth(), null, 2));
      return;
    }
    case 'export': {
      let runId: string | undefined = arg;
      if (!runId || runId === 'latest') {
        const h = await getHealth();
        runId = h.currentRun?.runId;
      }
      if (!runId) throw new Error('No run id given and no active run');
      const data = await exportRun(runId);
      const file = path.join(EVIDENCE_DIR, `${runId}.export.json`);
      writeJson(file, data);
      log(`Exported ${data.events.length} events, ${data.operations.length} operations -> ${path.relative(process.cwd(), file)}`);
      return;
    }
    case 'wipe-evidence': {
      if (!process.argv.includes('--yes')) {
        throw new Error('Refusing: this deletes all historical demo evidence. Re-run with --yes.');
      }
      await operator('POST', '/operator/evidence/wipe', { confirm: 'wipe-demo-evidence' });
      log('Historical demo evidence wiped; a fresh run was started.');
      return;
    }
    default:
      throw new Error(`Unknown command ${cmd}`);
  }
}

main().catch(e => {
  log(String(e.message ?? e));
  process.exit(1);
});
