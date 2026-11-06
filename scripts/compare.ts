/**
 * Compares the newest completed full replay artifacts of the ungated and gated
 * profiles: same principal, same normalized requests, same tool mapping and
 * schemas, different affected-resource authorization outcome.
 *
 *   yarn demo:compare [ungatedRunId gatedRunId]
 */
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE_DIR, log, writeJson } from './lib/env';

type Replay = {
  run: { runId: string; mode: string; startedAt: string };
  mode: string;
  direct: boolean;
  principal: string;
  toolMapping: Record<string, string | null>;
  normalizedRequests: unknown[];
  checks: Array<{ entityRef: string; observed: { outcome: string; present: boolean; executorAttempts: number }; pass: boolean }>;
  verdict: string;
  client: { protocolVersion?: string; server?: { name?: string; version?: string } };
};

function load(file: string): Replay {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function latest(mode: string): Replay | undefined {
  const files = fs
    .readdirSync(EVIDENCE_DIR)
    .filter(f => f.endsWith('.replay.json'))
    .map(f => path.join(EVIDENCE_DIR, f))
    .map(load)
    .filter(r => r.mode === mode && !r.direct)
    .sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
  return files.pop();
}

const [u, g] = process.argv.slice(2);
const ungated = u ? load(path.join(EVIDENCE_DIR, `${u}.replay.json`)) : latest('ungated-lab');
const gated = g ? load(path.join(EVIDENCE_DIR, `${g}.replay.json`)) : latest('gated');
if (!ungated || !gated) {
  log('Need one completed full replay per profile (yarn demo:replay in each).');
  process.exit(1);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const parity = {
  samePrincipal: ungated.principal === gated.principal,
  sameNormalizedRequests: same(ungated.normalizedRequests, gated.normalizedRequests),
  sameToolMapping: same(ungated.toolMapping, gated.toolMapping),
  sameProtocol: ungated.client.protocolVersion === gated.client.protocolVersion,
};
const row = (r: Replay, ref: string) => r.checks.find(c => c.entityRef === ref)?.observed;
const P = 'component:default/payments-api';
const C = 'component:default/checkout-preview';
const differsOnlyInResourceAuthorization =
  row(ungated, C)?.outcome === 'REMOVED_VERIFIED' &&
  row(gated, C)?.outcome === 'REMOVED_VERIFIED' &&
  row(ungated, P)?.outcome === 'REMOVED_VERIFIED' &&
  row(gated, P)?.outcome === 'DENIED' &&
  row(gated, P)?.present === true &&
  row(gated, P)?.executorAttempts === 0;

const report = {
  comparedAt: new Date().toISOString(),
  ungatedRun: ungated.run.runId,
  gatedRun: gated.run.runId,
  principal: { ungated: ungated.principal, gated: gated.principal },
  parity,
  outcomes: {
    [C]: { ungated: row(ungated, C), gated: row(gated, C) },
    [P]: { ungated: row(ungated, P), gated: row(gated, P) },
  } as Record<string, { ungated?: Replay['checks'][number]['observed']; gated?: Replay['checks'][number]['observed'] }>,
  differsOnlyInResourceAuthorization,
  verdict:
    Object.values(parity).every(Boolean) && differsOnlyInResourceAuthorization ? 'PASS' : 'FAIL',
};
writeJson(path.join(EVIDENCE_DIR, 'comparison.json'), report);

log(`Ungated run ${report.ungatedRun}  vs  gated run ${report.gatedRun}`);
for (const [k, v] of Object.entries(parity)) log(`  ${v ? 'same' : 'DIFFERENT'}: ${k}`);
for (const ref of [C, P]) {
  const o = report.outcomes[ref];
  log(
    `  ${ref}: ungated ${o.ungated?.outcome} (present=${o.ungated?.present}) | gated ${o.gated?.outcome} (present=${o.gated?.present}, executor attempts=${o.gated?.executorAttempts})`,
  );
}
log(
  `Authentication succeeded for ${gated.principal} in both runs; affected-resource authorization changed the outcome: ${report.verdict}`,
);
if (report.verdict !== 'PASS') process.exitCode = 1;
