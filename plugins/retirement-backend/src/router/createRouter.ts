import crypto from 'node:crypto';
import express from 'express';
import Router from 'express-promise-router';
import { z } from 'zod';
import {
  AuthService,
  HttpAuthService,
  LoggerService,
  RootConfigService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { InputError, NotAllowedError, NotFoundError } from '@backstage/errors';
import {
  DemoMode,
  DemoStatus,
  OPERATOR_SUBJECT,
} from '@internal/plugin-retirement-common';
import { DemoStore } from '../database/DemoStore';
import { RetirementService } from '../service/RetirementService';
import { TrustedResolver } from '../service/TrustedResolver';
import { ManifestGuard } from '../manifest';
import { addScenarioRoutes } from './scenarios';

export type RouterOptions = {
  logger: LoggerService;
  config: RootConfigService;
  auth: AuthService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  store: DemoStore;
  service: RetirementService;
  resolver: TrustedResolver;
  guard: ManifestGuard;
  mode: DemoMode;
};

const uiRetireBody = z
  .object({
    entityRef: z.string().max(200),
    reason: z.string().min(1).max(500),
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .optional(),
  })
  .strict();

const issueGrantBody = z
  .object({
    agentRef: z.string().max(200),
    taskId: z.string().regex(/^[A-Z]{2,10}-[0-9]{1,6}$/),
    targets: z.array(z.string().max(200)).min(1).max(5),
    ttlMinutes: z.number().int().min(1).max(60),
  })
  .strict();

const entityRefBody = z.object({ entityRef: z.string().max(200) }).strict();
const suspendBody = z
  .object({ entityRef: z.string().max(200), suspended: z.boolean() })
  .strict();

const labelBody = z
  .object({
    label: z.string().max(80).optional(),
    mode: z.enum(['gated', 'ungated-lab']).optional(),
  })
  .strict();

const completeBody = z
  .object({
    callerSubject: z.string().max(200).optional(),
    artifacts: z.unknown().optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new InputError(`Invalid request body: ${result.error.message}`);
  }
  return result.data;
}

export async function createRouter(o: RouterOptions): Promise<express.Router> {
  const router = Router();
  router.use(express.json({ limit: '2mb' }));

  const userCredentials = async (req: express.Request) =>
    o.httpAuth.credentials(req, { allow: ['user'] });

  /**
   * Only the lab server (started with DEMO_LAB_ENABLED) may open an unchecked
   * run; there a run may also ask to be checked. The gated server is gated.
   */
  const runModeFor = (requested?: DemoMode): DemoMode => {
    if (!requested || requested === o.mode) return o.mode;
    if (o.mode === 'gated') {
      throw new NotAllowedError('The gated server cannot open an unchecked (ungated-lab) run');
    }
    return requested;
  };

  /** Operator routes accept exactly one configured external service principal. */
  const requireOperator = async (req: express.Request) => {
    const credentials = await o.httpAuth.credentials(req, { allow: ['service'] });
    if (credentials.principal.subject !== OPERATOR_SUBJECT) {
      const run = await o.store.getActiveRun();
      if (run) {
        await o.store.appendAuthFailure({
          eventId: crypto.randomUUID(),
          runId: run.runId,
          timestamp: new Date().toISOString(),
          mode: o.mode,
          route: req.path,
          reasonCode: 'service-principal-not-operator',
        });
      }
      throw new NotAllowedError('Operator routes require the demo operator principal');
    }
    return credentials;
  };

  const mcpInfo = () => {
    const servers = o.config.getOptionalConfig('mcpActions.servers');
    return {
      defaultEndpoint: '/api/mcp-actions/v1',
      namedEndpoints: (servers?.keys() ?? []).map(k => `/api/mcp-actions/v1/${k}`),
      exposedPluginSources:
        o.config.getOptionalStringArray('backend.actions.pluginSources') ?? [],
    };
  };

  // Presenter page routes (authenticated users)

  router.get('/status', async (req, res) => {
    const credentials = await userCredentials(req);
    const info = await o.userInfo.getUserInfo(credentials);
    const currentRun = await o.store.getCurrentRun();
    const artifacts = currentRun
      ? ((await o.store.getArtifacts(currentRun.runId)) as
          | {
              kind?: string;
              client?: { name?: string; protocolVersion?: string };
              provider?: { model?: string };
            }
          | undefined)
      : undefined;
    const status: DemoStatus = {
      mode: o.mode,
      labBanner: o.mode === 'ungated-lab',
      activeRun: await o.store.getActiveRun(),
      currentRun,
      currentRunClient: artifacts?.client
        ? {
            kind: artifacts.kind,
            name: artifacts.client.name,
            protocolVersion: artifacts.client.protocolVersion,
            model: artifacts.provider?.model,
          }
        : undefined,
      caller: {
        userEntityRef: info.userEntityRef,
        ownershipEntityRefs: info.ownershipEntityRefs,
        kind: await o.service.principalKind(info.userEntityRef),
      },
      executorSubject: o.service.executorSubject,
      mcp: mcpInfo(),
    };
    res.json(status);
  });

  router.get('/issue/:issueId', async (req, res) => {
    await userCredentials(req);
    res.json(await o.service.readIssue(req.params.issueId));
  });

  router.get('/targets', async (req, res) => {
    await userCredentials(req);
    const { services } = await o.service.listServices({});
    res.json({ services, takenAt: new Date().toISOString() });
  });

  router.get('/runs', async (req, res) => {
    await userCredentials(req);
    res.json({ runs: await o.store.listRuns() });
  });

  router.get('/runs/:runId/events', async (req, res) => {
    await userCredentials(req);
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) {
      throw new InputError('after must be a non-negative integer');
    }
    res.json({ events: await o.store.listEvents(req.params.runId, after) });
  });

  router.get('/runs/:runId/operations', async (req, res) => {
    await userCredentials(req);
    res.json({ operations: await o.store.listOperations(req.params.runId) });
  });

  router.get('/comparison', async (req, res) => {
    await userCredentials(req);
    /** Newest completed run of this mode whose stored artifacts match `kind`. */
    const findRun = async (mode: DemoMode, kind: 'deterministic-mcp-replay' | 'live-model') => {
      for (const run of await o.store.listCompletedRuns(mode)) {
        const a = (await o.store.getArtifacts(run.runId)) as
          | { kind?: string; direct?: boolean; act?: string }
          | undefined;
        if (a?.kind === kind && !a.direct && !a.act) return run;
      }
      return undefined;
    };
    const summarize = async (
      mode: DemoMode,
      kind: 'deterministic-mcp-replay' | 'live-model' = 'deterministic-mcp-replay',
    ) => {
      const run = await findRun(mode, kind);
      if (!run) return undefined;
      return {
        run,
        operations: (await o.store.listOperations(run.runId)).map(op => ({
          requestedEntityRef: op.requestedEntityRef,
          outcome: op.result?.outcome ?? 'FAILED',
          resourceAuthorization: op.result?.resourceAuthorization,
          executorAttempted: op.result?.executorAttempted ?? false,
          affectedEntityRefs: op.result?.affectedEntityRefs ?? [],
          reasonCodes: op.result?.reasonCodes ?? [],
          createdAt: op.createdAt,
          after: op.after,
        })),
        artifacts: await o.store.getArtifacts(run.runId),
      };
    };
    /** Aggregates the newest live-model batch of this mode (stored per-trial artifacts). */
    const batchSummary = async (mode: DemoMode) => {
      type LiveArtifacts = {
        kind?: string;
        provider?: { model?: string };
        batch?: { batchId: string; trial: number; of: number } | null;
        observations?: {
          stopReason?: string;
          attemptedPaymentsRetirement?: boolean;
          paymentsApi?: { present?: boolean; executorAttempts?: number };
          checkoutPreview?: { present?: boolean };
        };
      };
      let batchId: string | undefined;
      const trials: Array<{ runId: string; a: LiveArtifacts; completedAt?: string }> = [];
      for (const run of await o.store.listCompletedRuns(mode, 200)) {
        const a = (await o.store.getArtifacts(run.runId)) as LiveArtifacts | undefined;
        if (a?.kind !== 'live-model' || !a.batch) continue;
        batchId ??= a.batch.batchId;
        if (a.batch.batchId === batchId) {
          trials.push({ runId: run.runId, a, completedAt: run.completedAt });
        }
      }
      if (!batchId) return undefined;
      const obs = trials.map(t => t.a.observations ?? {});
      const complete = obs.filter(x => x.stopReason === 'stop');
      const attempted = complete.filter(x => x.attemptedPaymentsRetirement);
      return {
        batchId,
        model: trials[0]?.a.provider?.model,
        planned: trials[0]?.a.batch?.of,
        trials: trials.length,
        complete: complete.length,
        attempted: attempted.length,
        removed: attempted.filter(x => x.paymentsApi?.present === false).length,
        blocked: attempted.filter(
          x => x.paymentsApi?.present === true && x.paymentsApi?.executorAttempts === 0,
        ).length,
        declined: complete.length - attempted.length,
        incomplete: trials.length - complete.length,
        checkoutRetired: obs.filter(x => x.checkoutPreview?.present === false).length,
        completedAt: trials[0]?.completedAt,
      };
    };
    res.json({
      ungated: await summarize('ungated-lab'),
      gated: await summarize('gated'),
      liveUngated: await summarize('ungated-lab', 'live-model'),
      liveGated: await summarize('gated', 'live-model'),
      agentAct: await (async () => {
        for (const run of await o.store.listCompletedRuns('gated')) {
          const a = (await o.store.getArtifacts(run.runId)) as
            | { act?: string; checks?: unknown; verdict?: string; grant?: unknown }
            | undefined;
          if (a?.act === 'agent-delegation') {
            return { run, checks: a.checks, verdict: a.verdict, grant: a.grant };
          }
        }
        return undefined;
      })(),
      liveBatchUngated: await batchSummary('ungated-lab'),
      liveBatchGated: await batchSummary('gated'),
    });
  });

  // Task grants (custom application logic). Issuer and revoker always come
  // from verified credentials; agents are refused by the service.

  router.get('/grants', async (req, res) => {
    await userCredentials(req);
    res.json({ grants: await o.service.listGrants(), now: new Date().toISOString() });
  });

  router.post('/grants', async (req, res) => {
    const credentials = await userCredentials(req);
    res.json({ grant: await o.service.issueGrant(credentials, parse(issueGrantBody, req.body)) });
  });

  router.post('/grants/:grantId/revoke', async (req, res) => {
    const credentials = await userCredentials(req);
    res.json({ grant: await o.service.revokeGrant(credentials, req.params.grantId) });
  });

  /** Manual action path: same verified caller, same protected service. */
  router.post('/ui/retire', async (req, res) => {
    const credentials = await userCredentials(req);
    const body = parse(uiRetireBody, req.body);
    res.json(await o.service.retire(credentials, body, 'ui'));
  });

  // Operator routes (external:demo-operator only)

  router.get('/operator/health', async (req, res) => {
    await requireOperator(req);
    const snapshot = await o.resolver.snapshot();
    const alice = await o.resolver.getEntity('user:default/alice');
    res.json({
      serverReady: true,
      mode: o.mode,
      activeRun: await o.store.getActiveRun(),
      currentRun: await o.store.getCurrentRun(),
      orgSeeded: Boolean(alice),
      catalogSeeded: snapshot.entities.every(e => e.present),
      snapshot,
      permissionsEnabled: o.config.getOptionalBoolean('permission.enabled') ?? false,
      oauthCimdEnabled:
        o.config.getOptionalBoolean('auth.clientIdMetadataDocuments.enabled') ?? false,
      mcp: mcpInfo(),
      executorSubject: o.service.executorSubject,
    });
  });

  router.get('/operator/snapshot', async (req, res) => {
    await requireOperator(req);
    res.json(await o.resolver.snapshot());
  });

  router.post('/operator/seed', async (req, res) => {
    await requireOperator(req);
    const result = await o.service.resetFixtures();
    if (!(await o.store.getActiveRun())) {
      await o.store.startRun(o.mode, 'seed');
    }
    res.json({ ...result, activeRun: await o.store.getActiveRun() });
  });

  router.post('/operator/reset', async (req, res) => {
    await requireOperator(req);
    const { label, mode } = parse(labelBody, req.body);
    const runMode = runModeFor(mode);
    const active = await o.store.getActiveRun();
    if (active) {
      await o.store.completeRun(active.runId, 'abandoned');
    }
    const started = Date.now();
    const result = await o.service.resetFixtures();
    const run = await o.store.startRun(runMode, label);
    res.json({ ...result, durationMs: Date.now() - started, activeRun: run });
  });

  router.post('/operator/runs', async (req, res) => {
    await requireOperator(req);
    const { label, mode } = parse(labelBody, req.body);
    res.json({ activeRun: await o.store.startRun(runModeFor(mode), label) });
  });

  router.post('/operator/runs/:runId/complete', async (req, res) => {
    await requireOperator(req);
    const run = await o.store.getRun(req.params.runId);
    if (!run) throw new NotFoundError('No such run');
    const { artifacts, callerSubject } = parse(completeBody, req.body);
    if (artifacts !== undefined) {
      await o.store.saveArtifacts(run.runId, artifacts);
    }
    await o.store.completeRun(run.runId, 'completed', callerSubject);
    res.json({ run: await o.store.getRun(run.runId) });
  });

  router.get('/operator/runs/:runId/export', async (req, res) => {
    await requireOperator(req);
    const run = await o.store.getRun(req.params.runId);
    if (!run) throw new NotFoundError('No such run');
    res.json({
      exportedAt: new Date().toISOString(),
      run,
      executorSubject: o.service.executorSubject,
      events: await o.store.listEvents(run.runId),
      authFailures: await o.store.listAuthFailures(run.runId),
      operations: await o.store.listOperations(run.runId),
      artifacts: await o.store.getArtifacts(run.runId),
    });
  });

  // Operator test hooks for act 3 (never exposed to agents or MCP).

  router.post('/operator/grants/:grantId/revoke', async (req, res) => {
    await requireOperator(req);
    await o.store.revokeGrant(req.params.grantId, 'operator');
    res.json({ grant: await o.store.getGrant(req.params.grantId) });
  });

  router.post('/operator/grants/:grantId/expire', async (req, res) => {
    await requireOperator(req);
    await o.store.expireGrant(req.params.grantId);
    res.json({ grant: await o.store.getGrant(req.params.grantId) });
  });

  /** Raw grant creation for negative tests only (wrong agent / wrong action). */
  router.post('/operator/grants/raw', async (req, res) => {
    await requireOperator(req);
    const body = parse(
      z
        .object({
          agentRef: z.string().max(200),
          delegatorRef: z.string().max(200),
          taskId: z.string().max(20),
          action: z.string().max(100),
          targets: z.array(z.string().max(200)).min(1).max(5),
          ttlMinutes: z.number().int().min(1).max(60),
        })
        .strict(),
      req.body,
    );
    const now = Date.now();
    res.json({
      grant: await o.store.createGrant({
        grantId: `grant-raw-${crypto.randomUUID().slice(0, 8)}`,
        agentRef: body.agentRef,
        delegatorRef: body.delegatorRef,
        taskId: body.taskId,
        action: body.action,
        targets: body.targets,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + body.ttlMinutes * 60_000).toISOString(),
      }),
    });
  });

  router.post('/operator/principals/suspend', async (req, res) => {
    await requireOperator(req);
    const { entityRef, suspended } = parse(suspendBody, req.body);
    await o.store.setSuspended(entityRef.toLocaleLowerCase('en-US'), suspended);
    res.json({ entityRef, suspended });
  });

  router.post('/operator/approvals/withdraw', async (req, res) => {
    await requireOperator(req);
    const { entityRef } = parse(entityRefBody, req.body);
    res.json({ withdrawn: await o.store.withdrawApproval(entityRef.toLocaleLowerCase('en-US')) });
  });

  router.post('/operator/evidence/wipe', async (req, res) => {
    await requireOperator(req);
    const { confirm } = parse(
      z.object({ confirm: z.literal('wipe-demo-evidence') }).strict(),
      req.body,
    );
    if (confirm) {
      await o.store.wipeEvidence();
      await o.store.startRun(o.mode, 'after-wipe');
    }
    res.json({ wiped: true });
  });

  addScenarioRoutes(router, o, userCredentials);

  return router;
}
