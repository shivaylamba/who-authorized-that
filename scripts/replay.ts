/**
 * Deterministic MCP replay — a scripted sequence of tool calls, NOT a
 * model-generated plan. It discovers tools and calls them over the native
 * Backstage MCP Actions endpoint with the official MCP SDK, using a
 * user-delegated token from the Backstage CLI.
 *
 *   yarn demo:replay [--instance alice] [--endpoint default|named] [--label x]
 *   yarn demo:replay:direct            # skip issue/list/preview; call retire on payments-api directly
 *
 * The runner continues after the expected payments denial so verification and
 * export complete. Results are stored as run artifacts and in evidence/.
 */
import path from 'node:path';
import { BACKEND_URL as BACKEND, EVIDENCE_DIR, log, writeJson } from './lib/env';
import { printToken, unverifiedClaims } from './lib/cliAuth';
import { exportRun, getHealth, getSnapshot, operator, requestedMode, startRun } from './lib/operator';
import { Envelope, LOGICAL_ACTIONS, callTool, connect, discoverTools } from './lib/mcp';
import type { RetirementResult } from '@internal/plugin-retirement-common';

const CHECKOUT = 'component:default/checkout-preview';
const PAYMENTS = 'component:default/payments-api';
const REASON = 'MIG-42 migration cleanup';

/** The normalized scenario. Identical arguments in both profiles. */
export const SCENARIO: Array<{ key: keyof typeof LOGICAL_ACTIONS; args: Record<string, unknown> }> = [
  { key: 'readIssue', args: { issueId: 'MIG-42' } },
  { key: 'listServices', args: {} },
  { key: 'previewRetirement', args: { entityRef: CHECKOUT } },
  { key: 'retireService', args: { entityRef: CHECKOUT, reason: REASON } },
  { key: 'previewRetirement', args: { entityRef: PAYMENTS } },
  { key: 'retireService', args: { entityRef: PAYMENTS, reason: REASON } },
];

export const DIRECT_SCENARIO: typeof SCENARIO = [
  { key: 'retireService', args: { entityRef: PAYMENTS, reason: REASON } },
];

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

type Outcome = { entityRef: string; outcome: string; present: boolean; executorAttempts: number; envelope?: Envelope };

export async function runReplay(opts: {
  instance: string;
  direct: boolean;
  endpointPath: string;
  label?: string;
}) {
  const token = await printToken(opts.instance);
  const principal = String(unverifiedClaims(token).sub);
  const health = await getHealth();
  const mode = requestedMode() ?? (health.mode as 'gated' | 'ungated-lab');
  const label = opts.label ?? `${opts.direct ? 'direct' : 'replay'}:${mode}`;
  const { activeRun } = await startRun(label);
  const runId: string = activeRun.runId;
  log(`Deterministic MCP replay (${opts.direct ? 'direct' : 'full'}) — profile ${mode}, run ${runId}`);
  log(`Caller from CLI token: ${principal} (validated by Backstage on every call)`);

  const pre = await getSnapshot();
  const session = await connect(token, opts.endpointPath);
  const serverVersion = session.client.getServerVersion();
  const protocolVersion = session.transport.protocolVersion;
  const { tools, mapping } = await discoverTools(session);
  log(`Connected to ${session.endpoint}: server ${serverVersion?.name}@${serverVersion?.version}, protocol ${protocolVersion}`);
  log(`Discovered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  const scenario = opts.direct ? DIRECT_SCENARIO : SCENARIO;
  const envelopes: Envelope[] = [];
  for (const step of scenario) {
    const logical = LOGICAL_ACTIONS[step.key];
    const toolName = mapping[step.key];
    if (!toolName) {
      envelopes.push({
        logicalAction: logical,
        toolName: '(not listed)',
        arguments: step.args,
        isError: true,
        text: [],
        protocolError: 'tool not present in tools/list for this caller',
      });
      log(`  ${logical}: not listed for this caller`);
      continue;
    }
    const env = await callTool(session, logical, toolName, step.args);
    envelopes.push(env);
    const summary = env.isError
      ? `ERROR ${env.protocolError ?? env.text.join(' ').slice(0, 200)}`
      : step.key === 'retireService'
      ? `outcome ${(env.structuredContent as RetirementResult | undefined)?.outcome}`
      : 'ok';
    log(`  ${toolName} ${JSON.stringify(step.args)} -> ${summary}`);
  }
  await session.close();

  // Independent verification: catalog read-back and backend event evidence.
  const post = await getSnapshot();
  const exported = await exportRun(runId);
  const outcomeFor = (entityRef: string): Outcome | undefined => {
    const env = [...envelopes]
      .reverse()
      .find(e => e.logicalAction === LOGICAL_ACTIONS.retireService && e.arguments.entityRef === entityRef);
    if (!env) return undefined;
    const ops = exported.operations.filter(o => o.requestedEntityRef === entityRef);
    const opIds = new Set(ops.map(o => o.operationId));
    const executorAttempts = exported.events.filter(
      e => opIds.has(e.operationId) && e.phase === 'executor-attempted',
    ).length;
    return {
      entityRef,
      outcome: env.isError
        ? env.text.join(' ').startsWith('NotAllowedError')
          ? 'DENIED'
          : 'FAILED'
        : String((env.structuredContent as RetirementResult | undefined)?.outcome),
      present: post.entities.find(e => e.entityRef === entityRef)?.present ?? false,
      executorAttempts,
      envelope: env,
    };
  };
  const outcomes = [CHECKOUT, PAYMENTS].map(outcomeFor).filter(Boolean) as Outcome[];

  const expected: Record<string, { outcome: string; present: boolean; executorAttempts?: number }> =
    mode === 'gated'
      ? {
          [CHECKOUT]: { outcome: 'REMOVED_VERIFIED', present: false },
          [PAYMENTS]: { outcome: 'DENIED', present: true, executorAttempts: 0 },
        }
      : {
          [CHECKOUT]: { outcome: 'REMOVED_VERIFIED', present: false },
          [PAYMENTS]: { outcome: 'REMOVED_VERIFIED', present: false },
        };
  const checks = outcomes.map(o => {
    const exp = expected[o.entityRef];
    const pass =
      o.outcome === exp.outcome &&
      o.present === exp.present &&
      (exp.executorAttempts === undefined || o.executorAttempts === exp.executorAttempts);
    return { entityRef: o.entityRef, expected: exp, observed: { outcome: o.outcome, present: o.present, executorAttempts: o.executorAttempts }, pass };
  });
  const verdict = checks.every(c => c.pass) ? 'PASS' : 'FAIL';

  const artifacts = {
    kind: 'deterministic-mcp-replay',
    label,
    direct: opts.direct,
    mode,
    principal,
    client: {
      name: 'who-authorized-that-replay (@modelcontextprotocol/sdk)',
      endpoint: session.endpoint,
      protocolVersion,
      server: serverVersion,
    },
    toolMapping: Object.fromEntries(
      Object.entries(LOGICAL_ACTIONS).map(([k, logical]) => [logical, mapping[k] ?? null]),
    ),
    normalizedRequests: scenario.map(s => ({ action: LOGICAL_ACTIONS[s.key], arguments: s.args })),
    envelopes,
    snapshots: { pre, post },
    checks,
    verdict,
  };
  await operator('POST', `/operator/runs/${encodeURIComponent(runId)}/complete`, {
    callerSubject: principal,
    artifacts,
  });
  const file = path.join(EVIDENCE_DIR, `${runId}.replay.json`);
  writeJson(file, { run: activeRun, ...artifacts });

  log('');
  for (const c of checks) {
    log(
      `  ${c.pass ? 'PASS' : 'FAIL'} ${c.entityRef}: ${c.observed.outcome}, ${
        c.observed.present ? 'still present' : 'absent'
      }, executor attempts ${c.observed.executorAttempts}`,
    );
  }
  log(`Verdict: ${verdict} (${mode}). Evidence: ${path.relative(process.cwd(), file)}`);
  return artifacts;
}

const LEGACY = 'component:default/legacy-checkout-worker';
const AGENT = 'user:default/mig42-agent';

/**
 * Act 3 — deterministic replay with a separate agent identity.
 * Alice issues a MIG-42 task grant (checkout-preview only) through the
 * authenticated grant route; the agent then works through MCP with its OWN
 * token; finally Alice retires legacy-checkout-worker herself, proving the
 * agent's authority is narrower than hers. Gated profile only.
 */
export async function runAgentReplay(opts: { label?: string; useExistingGrant?: boolean }) {
  const alice = await printToken('alice');
  const agent = await printToken('mig42-agent');
  const health = await getHealth();
  const mode = requestedMode() ?? (health.mode as 'gated' | 'ungated-lab');
  if (mode !== 'gated') {
    throw new Error('Act 3 runs gated: start the gated server, or pass --mode gated on the lab server.');
  }
  const label = opts.label ?? 'replay:agent-act3:gated';
  const { activeRun } = await startRun(label);
  const runId: string = activeRun.runId;
  log(`Deterministic MCP replay — ACT 3 (agent identity + task grant) — run ${runId}`);
  log(`Agent: ${String(unverifiedClaims(agent).sub)} · delegator: ${String(unverifiedClaims(alice).sub)}`);
  const pre = await getSnapshot();

  const grantReq = { agentRef: AGENT, taskId: 'MIG-42', targets: [CHECKOUT], ttlMinutes: 15 };
  type Grant = { grantId: string; agentRef: string; taskId: string; targets: string[]; expiresAt: string; status: string };
  let grant: Grant | undefined;
  if (opts.useExistingGrant) {
    // On stage Alice clicks "Delegate" in the UI; reuse that grant instead of issuing another.
    const list = await fetch(`${BACKEND}/api/retirement-demo/grants`, {
      headers: { Authorization: `Bearer ${alice}` },
    }).then(r => r.json() as Promise<{ grants: Grant[] }>);
    grant = list.grants.find(
      g => g.status === 'active' && g.agentRef === AGENT && g.targets.includes(CHECKOUT),
    );
    if (grant) log(`  Using Alice's existing grant ${grant.grantId} (issued from the presenter page)`);
  }
  if (!grant) {
    const res = await fetch(`${BACKEND}/api/retirement-demo/grants`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(grantReq),
    });
    const grantBody = await res.json();
    if (!res.ok) throw new Error(`grant issuance failed: ${JSON.stringify(grantBody)}`);
    grant = grantBody.grant as Grant;
    log(`  Alice issued ${grant.grantId}: ${grant.taskId} → ${grant.targets.join(', ')} until ${grant.expiresAt}`);
  }

  const steps: Array<{ who: 'agent' | 'alice'; key: keyof typeof LOGICAL_ACTIONS; args: Record<string, unknown> }> = [
    { who: 'agent', key: 'readIssue', args: { issueId: 'MIG-42' } },
    { who: 'agent', key: 'listServices', args: {} },
    { who: 'agent', key: 'previewRetirement', args: { entityRef: CHECKOUT } },
    { who: 'agent', key: 'retireService', args: { entityRef: CHECKOUT, reason: REASON } },
    { who: 'agent', key: 'previewRetirement', args: { entityRef: LEGACY } },
    { who: 'agent', key: 'retireService', args: { entityRef: LEGACY, reason: REASON } },
    { who: 'agent', key: 'retireService', args: { entityRef: PAYMENTS, reason: REASON } },
    { who: 'alice', key: 'retireService', args: { entityRef: LEGACY, reason: 'Alice retires her own approved service' } },
  ];
  const sessions = { agent: await connect(agent), alice: await connect(alice) };
  const { mapping } = await discoverTools(sessions.agent);
  const envelopes: Array<Envelope & { who: string }> = [];
  for (const step of steps) {
    const toolName = mapping[step.key]!;
    const env = await callTool(sessions[step.who], LOGICAL_ACTIONS[step.key], toolName, step.args);
    envelopes.push({ ...env, who: step.who });
    const summary = env.isError
      ? `ERROR ${env.text.join(' ').slice(0, 150)}`
      : step.key === 'retireService'
      ? `outcome ${(env.structuredContent as RetirementResult | undefined)?.outcome}`
      : 'ok';
    log(`  [${step.who}] ${toolName} ${JSON.stringify(step.args)} -> ${summary}`);
  }
  const protocolVersion = sessions.agent.transport.protocolVersion;
  await sessions.agent.close();
  await sessions.alice.close();

  const post = await getSnapshot();
  const exported = await exportRun(runId);
  const attempts = (who: string, ref: string) => {
    const subject = who === 'agent' ? AGENT : 'user:default/alice';
    const ops = new Set(
      exported.events
        .filter(e => e.caller.subject === subject && e.requestedEntityRef === ref)
        .map(e => e.operationId),
    );
    return exported.events.filter(e => ops.has(e.operationId) && e.phase === 'executor-attempted').length;
  };
  const outcome = (who: string, ref: string) => {
    const env = [...envelopes].reverse().find(
      e => e.who === who && e.logicalAction === LOGICAL_ACTIONS.retireService && e.arguments.entityRef === ref,
    );
    if (!env) return 'NOT_CALLED';
    return env.isError
      ? env.text.join(' ').startsWith('NotAllowedError') ? 'DENIED' : 'FAILED'
      : String((env.structuredContent as RetirementResult | undefined)?.outcome);
  };
  const present = (ref: string) => post.entities.find(e => e.entityRef === ref)?.present;
  const checks = [
    { who: 'agent', entityRef: CHECKOUT, expected: 'REMOVED_VERIFIED', executorAttempts: 1 },
    { who: 'agent', entityRef: LEGACY, expected: 'DENIED', executorAttempts: 0 },
    { who: 'agent', entityRef: PAYMENTS, expected: 'DENIED', executorAttempts: 0 },
    { who: 'alice', entityRef: LEGACY, expected: 'REMOVED_VERIFIED', executorAttempts: 1 },
  ].map(c => {
    const observed = { outcome: outcome(c.who, c.entityRef), executorAttempts: attempts(c.who, c.entityRef) };
    return { ...c, observed, pass: observed.outcome === c.expected && observed.executorAttempts === c.executorAttempts };
  });
  checks.push({
    who: 'catalog',
    entityRef: PAYMENTS,
    expected: 'PRESENT',
    executorAttempts: 0,
    observed: { outcome: present(PAYMENTS) ? 'PRESENT' : 'ABSENT', executorAttempts: attempts('agent', PAYMENTS) },
    pass: Boolean(present(PAYMENTS)),
  });
  const denial = envelopes.find(e => e.who === 'agent' && e.arguments.entityRef === LEGACY && e.logicalAction === LOGICAL_ACTIONS.retireService);
  const verdict = checks.every(c => c.pass) && /outside-task-grant/.test(denial?.text.join(' ') ?? '') ? 'PASS' : 'FAIL';

  const artifacts = {
    kind: 'deterministic-mcp-replay',
    act: 'agent-delegation',
    label,
    mode,
    principal: AGENT,
    delegator: 'user:default/alice',
    grant: { ...grant, note: 'custom application logic; not native Backstage task scoping or RFC 8693' },
    client: { name: 'who-authorized-that-replay (@modelcontextprotocol/sdk)', protocolVersion },
    normalizedRequests: [
      { action: 'POST /api/retirement-demo/grants (as alice)', arguments: grantReq },
      ...steps.map(s => ({ as: s.who, action: LOGICAL_ACTIONS[s.key], arguments: s.args })),
    ],
    envelopes,
    snapshots: { pre, post },
    checks,
    verdict,
  };
  await operator('POST', `/operator/runs/${encodeURIComponent(runId)}/complete`, {
    callerSubject: AGENT,
    artifacts,
  });
  const file = path.join(EVIDENCE_DIR, `${runId}.replay-agent.json`);
  writeJson(file, { run: activeRun, ...artifacts });
  log('');
  for (const c of checks) {
    log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.who} ${c.entityRef}: ${c.observed.outcome}, executor attempts ${c.observed.executorAttempts}`);
  }
  log(`Verdict: ${verdict} (act 3). Evidence: ${path.relative(process.cwd(), file)}`);
  return artifacts;
}

if (require.main === module && process.argv.includes('--agent')) {
  runAgentReplay({ label: arg('--label'), useExistingGrant: process.argv.includes('--use-existing-grant') })
    .then(a => {
      if (a.verdict !== 'PASS') process.exitCode = 1;
    })
    .catch(e => {
      log(String(e.stack ?? e));
      process.exit(1);
    });
} else if (require.main === module) {
  runReplay({
    instance: arg('--instance', 'alice')!,
    direct: process.argv.includes('--direct'),
    endpointPath:
      arg('--endpoint', 'default') === 'named'
        ? '/api/mcp-actions/v1/retirement'
        : '/api/mcp-actions/v1',
    label: arg('--label'),
  })
    .then(a => {
      if (a.verdict !== 'PASS') process.exitCode = 1;
    })
    .catch(e => {
      log(String(e.stack ?? e));
      process.exit(1);
    });
}
