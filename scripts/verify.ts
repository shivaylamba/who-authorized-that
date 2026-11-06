/**
 * Inspects actual catalog state and the expected operation evidence for the
 * newest completed replay run of the current profile.
 *
 *   yarn demo:verify [runId]
 */
import { log } from './lib/env';
import { exportRun, getHealth } from './lib/operator';

async function main() {
  const health = await getHealth();
  log(`Profile: ${health.mode}. Active run: ${health.activeRun?.runId ?? 'none'}`);
  log('Catalog state (independent read-back with the plugin read credentials):');
  for (const e of health.snapshot.entities) {
    log(`  ${e.present ? 'PRESENT ' : 'ABSENT  '} ${e.entityRef}`);
  }
  log(`  demo locations registered: ${health.snapshot.locations.length}`);

  let runId: string | undefined = process.argv[2];
  if (!runId) {
    const runs = await getHealth();
    runId = runs.currentRun?.runId;
  }
  if (!runId) throw new Error('No run id given and no current run');
  const exp = await exportRun(runId);
  log(`Run ${exp.run.runId} (${exp.run.mode}, ${exp.run.status}): ${exp.operations.length} operations`);
  let ok = true;
  for (const op of exp.operations) {
    const events = exp.events.filter(e => e.operationId === op.operationId);
    const attempts = events.filter(e => e.phase === 'executor-attempted').length;
    const decisions = events
      .filter(e => e.decision)
      .map(e => `${e.decision}${e.reasonCode ? `(${e.reasonCode})` : ''}`);
    const nowPresent = health.snapshot.entities.find(
      e => e.entityRef === op.requestedEntityRef,
    )?.present;
    // Consistency: a denied operation must have no executor attempt and no mutation.
    const consistent =
      op.result?.outcome !== 'DENIED' ||
      (attempts === 0 && !events.some(e => e.mutationOccurred));
    ok &&= consistent;
    log(
      `  ${op.requestedEntityRef}: ${op.result?.outcome ?? 'ERROR'}; executor attempts ${attempts}; decisions [${decisions.join(
        ', ',
      )}]; caller ${events[0]?.caller.subject}; executor ${
        events.find(e => e.executorSubject)?.executorSubject ?? 'none'
      }; now ${nowPresent ? 'present' : 'absent'}${consistent ? '' : '  <-- INCONSISTENT'}`,
    );
  }
  if (!ok) process.exitCode = 1;
}

main().catch(e => {
  log(String(e.message ?? e));
  process.exit(1);
});
