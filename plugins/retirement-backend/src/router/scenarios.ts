/**
 * The three dashboard scenarios. Each Run button resets the fixtures and runs
 * the existing MCP replay (or live-model) script as a child process, so every
 * scenario goes through real MCP with a real Backstage login:
 *
 *   1. as Alice, no per-resource check  (needs the lab server)
 *   2. as Alice, every resource checked
 *   3. as mig42-agent, under a task grant for checkout-preview only
 *
 * The dashboard reads each scenario's outcome from the run's backend events.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { ConflictError, InputError, NotAllowedError } from '@backstage/errors';
import { DemoMode, DemoEvent } from '@internal/plugin-retirement-common';
import type { RouterOptions } from './createRouter';

export const SCENARIO_ENTITIES = [
  'component:default/checkout-preview',
  'component:default/payments-api',
  'component:default/legacy-checkout-worker',
] as const;

type ScenarioId = '1' | '2' | '3';
type Spec = { mode: DemoMode; principal: string; replay: string[]; live: string[][] };

const SPECS: Record<ScenarioId, Spec> = {
  '1': {
    mode: 'ungated-lab',
    principal: 'user:default/alice',
    replay: ['scripts/replay.ts', '--mode', 'ungated-lab', '--label', 'scenario-1'],
    live: [['scripts/live-agent.ts', '--mode', 'ungated-lab', '--label', 'scenario-1-live']],
  },
  '2': {
    mode: 'gated',
    principal: 'user:default/alice',
    replay: ['scripts/replay.ts', '--mode', 'gated', '--label', 'scenario-2'],
    live: [['scripts/live-agent.ts', '--mode', 'gated', '--label', 'scenario-2-live']],
  },
  '3': {
    mode: 'gated',
    principal: 'user:default/mig42-agent',
    replay: ['scripts/replay.ts', '--agent', '--mode', 'gated', '--label', 'scenario-3'],
    live: [
      ['scripts/grant.ts'],
      ['scripts/live-agent.ts', '--as', 'mig42-agent', '--mode', 'gated', '--label', 'scenario-3-live'],
    ],
  },
};

type State = {
  status: 'idle' | 'running' | 'done' | 'error';
  live: boolean;
  runId?: string;
  error?: string;
  startedAt?: string;
};

export type ScenarioRow = {
  entityRef: string;
  outcome: 'deleted' | 'blocked' | 'failed' | 'untouched';
  reason?: string;
  checkSkipped?: boolean;
};

/** One retire request the agent made, in the order it made them. */
export type ScenarioRequest = {
  entityRef: string;
  check: 'none' | 'allowed' | 'denied' | 'pending';
  outcome: 'deleted' | 'blocked' | 'failed' | 'pending';
  reason?: string;
};

export function requestsFromEvents(events: DemoEvent[], principal: string): ScenarioRequest[] {
  const order: string[] = [];
  for (const e of events) {
    if (e.caller?.subject !== principal || !e.requestedEntityRef) continue;
    if (e.actionId && !e.actionId.endsWith('retire-service')) continue;
    if (!order.includes(e.requestedEntityRef)) order.push(e.requestedEntityRef);
  }
  return order.map(entityRef => {
    const mine = events.filter(
      e => e.caller?.subject === principal && e.requestedEntityRef === entityRef,
    );
    const denied = mine.find(e => e.phase === 'denied');
    const failed = mine.find(e => e.phase === 'failed');
    const check: ScenarioRequest['check'] = mine.some(e => e.phase === 'authorization-skipped')
      ? 'none'
      : denied
      ? 'denied'
      : mine.some(e => e.phase === 'authorized')
      ? 'allowed'
      : 'pending';
    const outcome: ScenarioRequest['outcome'] = mine.some(e => e.phase === 'verification-succeeded')
      ? 'deleted'
      : denied
      ? 'blocked'
      : failed
      ? 'failed'
      : 'pending';
    return { entityRef, check, outcome, reason: denied?.reasonCode ?? failed?.reasonCode };
  });
}

const runBody = z.object({ live: z.boolean().optional() }).strict();
const RUN_ID = /(run-\d{4}-\d\d-\d\dT[\w-]+-[0-9a-f]{6})/;

export function rowsFromEvents(events: DemoEvent[], principal: string): ScenarioRow[] {
  return SCENARIO_ENTITIES.map(entityRef => {
    const mine = events.filter(
      e => e.caller?.subject === principal && e.requestedEntityRef === entityRef,
    );
    const denied = mine.find(e => e.phase === 'denied');
    const checkSkipped = mine.some(e => e.phase === 'authorization-skipped');
    if (mine.some(e => e.phase === 'verification-succeeded')) {
      return { entityRef, outcome: 'deleted', checkSkipped };
    }
    if (denied) return { entityRef, outcome: 'blocked', reason: denied.reasonCode };
    if (mine.some(e => e.phase === 'failed')) {
      return { entityRef, outcome: 'failed', reason: mine.find(e => e.phase === 'failed')?.reasonCode };
    }
    return { entityRef, outcome: 'untouched' };
  });
}

export function addScenarioRoutes(
  router: express.Router,
  o: RouterOptions,
  requireUser: (req: express.Request) => Promise<unknown>,
) {
  const root = path.resolve(
    o.config.getOptionalString('retirementDemo.repoRoot') ?? path.resolve(process.cwd(), '../..'),
  );
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  const states: Record<ScenarioId, State> = {
    '1': { status: 'idle', live: false },
    '2': { status: 'idle', live: false },
    '3': { status: 'idle', live: false },
  };
  let busy: ScenarioId | undefined;

  const runScript = (args: string[], onRunId: (id: string) => void) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(tsx, args, { cwd: root, env: process.env });
      let tail = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
      const onData = (d: Buffer) => {
        const text = d.toString();
        tail = (tail + text).slice(-2000);
        const m = text.match(RUN_ID);
        if (m) onRunId(m[1]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const last = tail.trim().split('\n').filter(Boolean).slice(-3).join(' ');
          reject(new Error(`exit ${code}: ${last.slice(0, 400)}`));
        }
      });
    });

  /**
   * "What Backstage gives you today": read from the newest findings run
   * (yarn demo:findings), which measures this server. Nothing is hard-coded.
   */
  router.get('/scenarios/facts', async (req, res) => {
    await requireUser(req);
    const dir = path.join(root, 'evidence');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /^findings-.*\.json$/.test(f)).sort()
      : [];
    let version: string | undefined;
    try {
      version = JSON.parse(fs.readFileSync(path.join(root, 'backstage.json'), 'utf8')).version;
    } catch {
      version = undefined;
    }
    const permissionFramework = o.config.getOptionalBoolean('permission.enabled') ?? false;
    if (!files.length) {
      res.json({ measured: false, version, permissionFramework });
      return;
    }
    type Observed = {
      scopes_supported?: string[];
      grant_types_supported?: string[];
      claims?: { aud?: string; lifetimeSeconds?: number };
      sameTokenOnMcp?: number;
      sameTokenOnCatalogRest?: number;
    };
    type Finding = { id: string; observed: Observed };
    const latest = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')) as {
      ranAt: string;
      findings: Finding[];
    };
    const f = (prefix: string): Observed =>
      latest.findings.find(x => x.id.startsWith(prefix))?.observed ?? {};
    const f1 = f('F1');
    const f2 = f('F2');
    const scopes: string[] = f1.scopes_supported ?? [];
    const grantTypes: string[] = f1.grant_types_supported ?? [];
    res.json({
      measured: true,
      measuredAt: latest.ranAt,
      version,
      permissionFramework,
      tokenLifetimeSeconds: f2.claims?.lifetimeSeconds,
      audience: f2.claims?.aud,
      worksOnMcp: f2.sameTokenOnMcp === 200,
      worksOnCatalogApi: f2.sameTokenOnCatalogRest === 200,
      scopes,
      grantTypes,
      scoped: scopes.some(x => x !== 'openid' && x !== 'offline_access'),
      tokenExchange: grantTypes.includes('urn:ietf:params:oauth:grant-type:token-exchange'),
    });
  });

  router.get('/scenarios', async (req, res) => {
    await requireUser(req);
    const scenarios = await Promise.all(
      (Object.keys(SPECS) as ScenarioId[]).map(async id => {
        const s = states[id];
        const events = s.runId ? await o.store.listEvents(s.runId) : [];
        return {
          id,
          ...s,
          principal: SPECS[id].principal,
          requests: s.runId ? requestsFromEvents(events, SPECS[id].principal) : [],
          rows: s.runId
            ? rowsFromEvents(events, SPECS[id].principal)
            : SCENARIO_ENTITIES.map(entityRef => ({ entityRef, outcome: 'untouched' as const })),
        };
      }),
    );
    res.json({ labServer: o.mode === 'ungated-lab', busy: busy ?? null, scenarios });
  });

  router.post('/scenarios/reset', async (req, res) => {
    await requireUser(req);
    if (busy) throw new ConflictError(`Scenario ${busy} is still running`);
    await o.service.resetFixtures();
    await o.store.startRun(o.mode, 'dashboard-reset');
    for (const id of Object.keys(states) as ScenarioId[]) states[id] = { status: 'idle', live: false };
    res.json({ ok: true });
  });

  router.post('/scenarios/:id/run', async (req, res) => {
    await requireUser(req);
    const id = req.params.id as ScenarioId;
    const spec = SPECS[id];
    if (!spec) throw new InputError('Unknown scenario');
    const { live = false } = runBody.parse(req.body ?? {});
    if (spec.mode === 'ungated-lab' && o.mode !== 'ungated-lab') {
      throw new NotAllowedError(
        'Scenario 1 needs the lab server (yarn demo:start:ungated); this server is always checked.',
      );
    }
    if (busy) throw new ConflictError(`Scenario ${busy} is still running`);
    busy = id;
    states[id] = { status: 'running', live, startedAt: new Date().toISOString() };
    res.status(202).json({ started: id });

    (async () => {
      try {
        await o.service.resetFixtures();
        const steps = live ? spec.live : [spec.replay];
        for (const args of steps) {
          await runScript(args, runId => {
            states[id].runId = runId;
          });
        }
        states[id].status = 'done';
      } catch (e) {
        states[id].status = 'error';
        states[id].error = (e as Error).message;
        o.logger.warn(`Scenario ${id} failed: ${(e as Error).message}`);
      } finally {
        busy = undefined;
      }
    })();
  });
}
