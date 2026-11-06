import path from 'node:path';
import knexFactory, { Knex } from 'knex';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { PermissionsService } from '@backstage/backend-plugin-api';
import { Entity } from '@backstage/catalog-model';
import {
  AuthorizeResult,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  DemoMode,
  TrustedClassification,
} from '@internal/plugin-retirement-common';
import {
  affectedSetVersion,
  explainGatedRule,
  parseResourceRef,
} from '../classification';
import { DemoStore } from '../database/DemoStore';
import { ManifestGuard, ManifestTarget, loadManifest } from '../manifest';
import { CatalogExecutor } from './PrivilegedCatalogExecutor';
import { RetirementService } from './RetirementService';
import { AffectedSet, TargetResolver } from './TrustedResolver';

const guard = new ManifestGuard(
  loadManifest(path.resolve(__dirname, '../../../../fixtures')),
);

const ALICE_CLAIMS = ['user:default/alice', 'group:default/checkout-team'];

type Attrs = Partial<Omit<TrustedClassification, 'entityRef' | 'version'>>;

/** In-memory catalog world built from the real manifest. */
class FakeWorld implements TargetResolver {
  entities = new Map<string, TrustedClassification>();
  registered = new Set<string>();
  incomplete = new Set<string>();

  constructor() {
    const attrs: Record<string, Attrs> = {
      'component:default/checkout-preview': {
        owner: 'group:default/checkout-team', environment: 'development', lifecycle: 'deprecated', retirementApproved: true,
      },
      'component:default/payments-api': {
        owner: 'group:default/payments-team', environment: 'production', lifecycle: 'production', retirementApproved: false,
      },
      'component:default/checkout-v2': {
        owner: 'group:default/checkout-team', environment: 'development', lifecycle: 'experimental', retirementApproved: false,
      },
      'component:default/legacy-checkout-worker': {
        owner: 'group:default/checkout-team', environment: 'development', lifecycle: 'deprecated', retirementApproved: true,
      },
      'component:default/checkout-lint-bot': {
        owner: 'group:default/checkout-team', environment: 'development', lifecycle: 'deprecated', retirementApproved: true,
      },
      'component:default/payments-ledger-sandbox': {
        owner: 'group:default/payments-team', environment: 'development', lifecycle: 'deprecated', retirementApproved: true,
      },
    };
    for (const target of guard.manifest.targets) this.register(target, attrs);
    this.attrs = attrs;
  }

  private attrs: Record<string, Attrs>;

  register(target: ManifestTarget, attrs: Record<string, Attrs> = this.attrs) {
    this.registered.add(target.id);
    for (const ref of target.entityRefs) {
      const a = attrs[ref];
      this.entities.set(ref, {
        entityRef: ref,
        kind: 'Component',
        uid: `uid-${ref}`,
        retirementApproved: false,
        ...a,
        version: `${ref}-${JSON.stringify(a)}`.length.toString(16).padStart(24, '0'),
      });
    }
  }

  unregister(targetId: string) {
    const target = guard.manifest.targets.find(t => t.id === targetId)!;
    this.registered.delete(targetId);
    for (const ref of target.entityRefs) this.entities.delete(ref);
  }

  users: Record<string, Entity> = {
    'user:default/alice': user('alice', ['group:default/checkout-team']),
    'user:default/bob': user('bob', ['group:default/visitors']),
    'user:default/mig42-agent': user('mig42-agent', ['group:default/agents'], true),
  };
  onResolve?: () => Promise<void>;

  async getEntity(ref: string) {
    if (this.users[ref]) return this.users[ref];
    return this.entities.has(ref)
      ? ({ apiVersion: 'v1', kind: 'Component', metadata: { name: ref } } as Entity)
      : undefined;
  }

  async classify(ref: string) {
    return this.entities.get(ref);
  }

  async resolveAffectedSet(ref: string): Promise<AffectedSet> {
    await this.onResolve?.();
    const requested = this.entities.get(ref);
    if (!requested) {
      return { requestedEntityRef: ref, present: false, affected: [], complete: false, problems: ['entity-absent'] };
    }
    const target = guard.targetForEntityRef(ref)!;
    const affected = target.entityRefs
      .map(r => this.entities.get(r))
      .filter((c): c is TrustedClassification => Boolean(c));
    const location = { id: target.id, target: target.locationTarget };
    const problems = this.incomplete.has(ref) ? ['affected-set-incomplete'] : [];
    return {
      requestedEntityRef: ref,
      present: true,
      requested,
      location,
      affected,
      complete: problems.length === 0,
      problems,
      version: affectedSetVersion(location, affected),
    };
  }

  async snapshot() {
    return {
      takenAt: new Date().toISOString(),
      entities: guard.allManagedEntityRefs().map(entityRef => ({
        entityRef,
        present: this.entities.has(entityRef),
      })),
      locations: [],
    };
  }

  async findLocationForTarget(locationTarget: string) {
    const t = guard.targetForLocation(locationTarget)!;
    return this.registered.has(t.id) ? { id: t.id, target: locationTarget } : undefined;
  }
}

function user(name: string, groups: string[], agent = false): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: {
      name,
      annotations: agent ? { 'retirement-demo.example.com/account-type': 'agent' } : {},
    },
    relations: groups.map(targetRef => ({ type: 'memberOf', targetRef })),
  };
}

class FakeExecutor implements CatalogExecutor {
  readonly subject = 'demo-retirement-executor';
  calls: string[] = [];
  delayMs = 0;
  fail = false;
  removes = true;
  constructor(private readonly world: FakeWorld) {}

  async unregisterLocation(location: { id: string; target: string }) {
    if (!guard.targetForLocation(location.target)) throw new Error('outside manifest');
    this.calls.push(`unregister:${location.id}`);
    await new Promise(r => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error('catalog unavailable');
    if (this.removes) this.world.unregister(location.id);
  }

  async registerLocation(target: ManifestTarget) {
    this.calls.push(`register:${target.id}`);
    this.world.register(target);
    return { id: target.id };
  }
}

type PermissionMode = 'policy' | 'throw' | 'conditional';

/** Stand-in for the permission backend. 'policy' mirrors the demo policy's resource rule. */
function fakePermissions(world: FakeWorld, mode: () => PermissionMode) {
  const calls: string[] = [];
  const service: PermissionsService = {
    async authorize(requests) {
      calls.push(...requests.map(r => ('resourceRef' in r ? String(r.resourceRef) : r.permission.name)));
      if (mode() === 'throw') throw new Error('permission backend unavailable');
      return requests.map(r => {
        if (mode() === 'conditional') {
          return { result: AuthorizeResult.CONDITIONAL } as unknown as { result: AuthorizeResult.ALLOW };
        }
        const parsed = parseResourceRef(String('resourceRef' in r ? r.resourceRef : ''));
        const c = parsed && world.entities.get(parsed.entityRef);
        const allowed = Boolean(c && c.version === parsed?.version && explainGatedRule(c, ALICE_CLAIMS).length === 0);
        return { result: allowed ? AuthorizeResult.ALLOW : AuthorizeResult.DENY };
      });
    },
    async authorizeConditional() {
      return [{ result: AuthorizeResult.DENY } as PolicyDecision];
    },
  };
  return { service, calls };
}

describe('RetirementService', () => {
  let db: Knex;
  let store: DemoStore;
  let world: FakeWorld;
  let executor: FakeExecutor;
  let permissionMode: PermissionMode;
  let permissionCalls: string[];

  let audits: Array<{ eventId: string; status: 'success' | 'fail'; meta?: unknown; error?: string }>;
  const auditor = {
    createEvent: async ({ eventId }: { eventId: string }) => ({
      success: async (o?: { meta?: unknown }) => {
        audits.push({ eventId, status: 'success', meta: o?.meta });
      },
      fail: async (o: { meta?: unknown; error: Error }) => {
        audits.push({ eventId, status: 'fail', meta: o.meta, error: o.error.name });
      },
    }),
  };
  const make = (mode: DemoMode) => {
    const perms = fakePermissions(world, () => permissionMode);
    permissionCalls = perms.calls;
    return new RetirementService({
      auditor,
      mode,
      logger: mockServices.logger.mock(),
      auth: mockServices.auth(),
      permissions: perms.service,
      userInfo: mockServices.userInfo({ ownershipEntityRefs: ALICE_CLAIMS }),
      store,
      guard,
      resolver: world,
      executor,
      verification: { timeoutMs: 200, intervalMs: 10 },
    });
  };
  const alice = mockCredentials.user('user:default/alice');
  const retire = (svc: RetirementService, entityRef: string, extra: object = {}) =>
    svc.retire(alice, { entityRef, reason: 'MIG-42 migration cleanup', ...extra }, 'mcp');
  const events = async () => {
    const run = await store.getActiveRun();
    return store.listEvents(run!.runId);
  };

  beforeEach(async () => {
    db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    store = await DemoStore.create(db);
    await store.replaceApprovals(guard.manifest.approvals);
    world = new FakeWorld();
    executor = new FakeExecutor(world);
    permissionMode = 'policy';
    audits = [];
  });
  afterEach(() => db.destroy());

  describe('gated', () => {
    beforeEach(() => store.startRun('gated'));

    it('removes checkout-preview after a per-entity ALLOW and verifies absence', async () => {
      const r = await retire(make('gated'), 'component:default/checkout-preview');
      expect(r.outcome).toBe('REMOVED_VERIFIED');
      expect(r.resourceAuthorization).toBe('enforced');
      expect(executor.calls).toEqual(['unregister:checkout-preview']);
      const ev = await events();
      expect(ev.map(e => e.phase)).toEqual([
        'authenticated', 'resolved', 'authorized', 'executor-attempted', 'executor-succeeded', 'verification-succeeded',
      ]);
      expect(ev.find(e => e.phase === 'authorized')?.decision).toBe('ALLOW');
      expect(ev.find(e => e.phase === 'executor-attempted')).toMatchObject({
        caller: { type: 'user', subject: 'user:default/alice' },
        executorSubject: 'demo-retirement-executor',
      });
    });

    it('emits native audit events for success and denial', async () => {
      const svc = make('gated');
      await retire(svc, 'component:default/checkout-preview');
      await expect(retire(svc, 'component:default/payments-api')).rejects.toThrow();
      expect(audits).toEqual([
        expect.objectContaining({
          eventId: 'retire-service',
          status: 'success',
          meta: expect.objectContaining({
            outcome: 'REMOVED_VERIFIED',
            executorSubject: 'demo-retirement-executor',
            executorAttempted: true,
            caller: { subject: 'user:default/alice', kind: 'human' },
          }),
        }),
        expect.objectContaining({
          eventId: 'retire-service',
          status: 'fail',
          error: 'NotAllowedError',
          meta: expect.objectContaining({ outcome: 'DENIED', executorAttempted: false }),
        }),
      ]);
    });

    it('denies payments-api before any executor call and leaves it present', async () => {
      await expect(retire(make('gated'), 'component:default/payments-api')).rejects.toMatchObject({ name: 'NotAllowedError' });
      expect(executor.calls).toEqual([]);
      expect(world.entities.has('component:default/payments-api')).toBe(true);
      const ev = await events();
      expect(ev.some(e => e.phase === 'executor-attempted')).toBe(false);
      expect(ev.some(e => e.mutationOccurred)).toBe(false);
      const [op] = await store.listOperations((await store.getActiveRun())!.runId);
      expect(op.result?.outcome).toBe('DENIED');
    });

    it('denies checkout-v2 even though Alice owns it', async () => {
      await expect(retire(make('gated'), 'component:default/checkout-v2')).rejects.toThrow(/not-deprecated.*retirement-not-approved/);
      expect(executor.calls).toEqual([]);
    });

    it('denies a mixed-owner location as a whole before deleting anything', async () => {
      await expect(retire(make('gated'), 'component:default/checkout-lint-bot')).rejects.toThrow(
        /payments-ledger-sandbox: not-owned-by-caller/,
      );
      expect(executor.calls).toEqual([]);
      expect(world.entities.has('component:default/checkout-lint-bot')).toBe(true);
      expect(world.entities.has('component:default/payments-ledger-sandbox')).toBe(true);
      expect(permissionCalls).toHaveLength(2);
    });

    it('fails closed when the permission service errors', async () => {
      permissionMode = 'throw';
      await expect(retire(make('gated'), 'component:default/checkout-preview')).rejects.toThrow(/permission-service-error/);
      expect(executor.calls).toEqual([]);
    });

    it('does not treat CONDITIONAL as ALLOW', async () => {
      permissionMode = 'conditional';
      await expect(retire(make('gated'), 'component:default/checkout-preview')).rejects.toMatchObject({ name: 'NotAllowedError' });
      expect(executor.calls).toEqual([]);
    });

    it('denies an incomplete affected set without asking for permission', async () => {
      world.incomplete.add('component:default/checkout-preview');
      await expect(retire(make('gated'), 'component:default/checkout-preview')).rejects.toThrow(/affected-set-incomplete/);
      expect(permissionCalls).toEqual([]);
      expect(executor.calls).toEqual([]);
    });

    it('rejects a stale expectedVersion and never reuses preview as a grant', async () => {
      const svc = make('gated');
      const preview = await svc.preview(alice, 'component:default/checkout-preview');
      expect(preview.callerAssessment.allowedByTrustedRule).toBe(true);
      // A checkout preview version does not authorize payments.
      await expect(
        retire(svc, 'component:default/payments-api', { expectedVersion: preview.resourceVersion }),
      ).rejects.toMatchObject({ name: 'ConflictError' });
      await expect(
        retire(svc, 'component:default/checkout-preview', { expectedVersion: 'f'.repeat(24) }),
      ).rejects.toThrow(/stale-version/);
      expect(executor.calls).toEqual([]);
    });

    it('rejects service principals, unknown refs and URLs', async () => {
      const svc = make('gated');
      await expect(
        svc.retire(mockCredentials.service('external:demo-operator'), { entityRef: 'component:default/checkout-preview', reason: 'x' }, 'mcp'),
      ).rejects.toThrow(/caller-must-be-a-user-principal/);
      await expect(retire(svc, 'component:default/not-in-manifest')).rejects.toMatchObject({ name: 'NotFoundError' });
      await expect(retire(svc, 'https://example.com/catalog-info.yaml')).rejects.toMatchObject({ name: 'InputError' });
      await expect(retire(svc, 'user:default/alice')).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(executor.calls).toEqual([]);
    });

    it('records executor failure as FAILED without claiming removal', async () => {
      executor.fail = true;
      await expect(retire(make('gated'), 'component:default/checkout-preview')).rejects.toThrow(/catalog unavailable/);
      const [op] = await store.listOperations((await store.getActiveRun())!.runId);
      expect(op.result?.outcome).toBe('FAILED');
      expect((await events()).some(e => e.phase === 'verification-succeeded')).toBe(false);
    });

    it('reports UNVERIFIED when read-back still sees the entity', async () => {
      executor.removes = false;
      const r = await retire(make('gated'), 'component:default/checkout-preview');
      expect(r.outcome).toBe('UNVERIFIED');
    });

    it('returns ALREADY_ABSENT without calling the executor', async () => {
      world.unregister('checkout-preview');
      const r = await retire(make('gated'), 'component:default/checkout-preview');
      expect(r.outcome).toBe('ALREADY_ABSENT');
      expect(executor.calls).toEqual([]);
    });

    it('serializes a retirement and a concurrent reset for the same location', async () => {
      const svc = make('gated');
      executor.delayMs = 50;
      const [r] = await Promise.all([
        retire(svc, 'component:default/checkout-preview'),
        new Promise(res => setTimeout(res, 5)).then(() => svc.resetFixtures()),
      ]);
      expect(r.outcome).toBe('REMOVED_VERIFIED');
      expect(executor.calls.indexOf('unregister:checkout-preview')).toBeLessThan(
        executor.calls.indexOf('register:checkout-preview'),
      );
      expect(world.entities.has('component:default/checkout-preview')).toBe(true);
    });
  });

  describe('act 3: agent account under a task grant (gated)', () => {
    const agent = mockCredentials.user('user:default/mig42-agent');
    const AGENT = 'user:default/mig42-agent';
    const CP = 'component:default/checkout-preview';
    const LEGACY = 'component:default/legacy-checkout-worker';
    const PAY = 'component:default/payments-api';
    beforeEach(() => store.startRun('gated'));

    const agentRetire = (svc: RetirementService, entityRef: string) =>
      svc.retire(agent, { entityRef, reason: 'MIG-42' }, 'mcp');
    const grant = (svc: RetirementService, targets: string[], ttlMinutes = 15) =>
      svc.issueGrant(alice, { agentRef: AGENT, taskId: 'MIG-42', targets, ttlMinutes });
    const rawGrant = (over: Partial<{ agentRef: string; action: string; targets: string[] }>) =>
      store.createGrant({
        grantId: `g-${Math.random()}`,
        agentRef: over.agentRef ?? AGENT,
        delegatorRef: 'user:default/alice',
        taskId: 'MIG-42',
        action: over.action ?? 'retirement-demo:retire-service',
        targets: over.targets ?? [CP],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

    it('has narrower authority than Alice: grant covers checkout-preview only', async () => {
      const svc = make('gated');
      const g = await grant(svc, [CP]);
      expect(g.delegatorRef).toBe('user:default/alice');
      expect((await agentRetire(svc, CP)).outcome).toBe('REMOVED_VERIFIED');
      await expect(agentRetire(svc, LEGACY)).rejects.toThrow(/outside-task-grant/);
      await expect(agentRetire(svc, PAY)).rejects.toThrow(/outside-task-grant/);
      expect(executor.calls).toEqual(['unregister:checkout-preview']);
      // The decisive comparison: Alice herself may retire the legacy worker.
      expect((await retire(svc, LEGACY)).outcome).toBe('REMOVED_VERIFIED');
      const ev = await events();
      const allowed = ev.find(e => e.phase === 'executor-attempted' && e.delegation);
      expect(allowed?.delegation).toMatchObject({ agentRef: AGENT, delegatorRef: 'user:default/alice', taskId: 'MIG-42' });
      expect(allowed?.caller).toMatchObject({ subject: AGENT, kind: 'agent' });
    });

    it('denies an agent with no grant without calling the executor', async () => {
      await expect(agentRetire(make('gated'), CP)).rejects.toThrow(/no-task-grant/);
      expect(executor.calls).toEqual([]);
    });

    it('agents cannot issue grants; humans cannot delegate beyond their authority or to non-agents', async () => {
      const svc = make('gated');
      await expect(
        svc.issueGrant(agent, { agentRef: AGENT, taskId: 'MIG-42', targets: [LEGACY], ttlMinutes: 5 }),
      ).rejects.toThrow(/agents-cannot-issue-or-expand-grants/);
      await expect(grant(svc, [PAY])).rejects.toThrow(/delegator-cannot-delegate/);
      await expect(
        svc.issueGrant(alice, { agentRef: 'user:default/bob', taskId: 'MIG-42', targets: [CP], ttlMinutes: 5 }),
      ).rejects.toThrow(/grantee-is-not-an-agent-account/);
      await expect(grant(svc, [CP], 61)).rejects.toMatchObject({ name: 'InputError' });
      await expect(
        svc.issueGrant(alice, { agentRef: AGENT, taskId: 'NOPE-1', targets: [CP], ttlMinutes: 5 }),
      ).rejects.toMatchObject({ name: 'NotFoundError' });
    });

    it('rejects expired and revoked grants', async () => {
      const svc = make('gated');
      const g1 = await grant(svc, [CP]);
      await store.expireGrant(g1.grantId);
      await expect(agentRetire(svc, CP)).rejects.toThrow(/task-grant-expired/);
      const g2 = await grant(svc, [CP]);
      await svc.revokeGrant(alice, g2.grantId);
      await expect(agentRetire(svc, CP)).rejects.toThrow(/task-grant-revoked/);
      expect(executor.calls).toEqual([]);
    });

    it('rejects grants for another agent, another action, or another target', async () => {
      const svc = make('gated');
      await rawGrant({ agentRef: 'user:default/other-agent' });
      await expect(agentRetire(svc, CP)).rejects.toThrow(/no-task-grant/);
      await rawGrant({ action: 'retirement-demo:something-else' });
      await expect(agentRetire(svc, CP)).rejects.toThrow(/grant-is-for-another-action/);
      await rawGrant({ targets: [LEGACY] });
      await expect(agentRetire(svc, CP)).rejects.toThrow(/outside-task-grant/);
      expect(executor.calls).toEqual([]);
    });

    it("stops when Alice loses authority after issuing the grant", async () => {
      const svc = make('gated');
      await grant(svc, [CP]);
      await store.setSuspended('user:default/alice', true);
      await expect(agentRetire(svc, CP)).rejects.toThrow(/delegator-suspended/);
      await store.setSuspended('user:default/alice', false);
      // Approval withdrawn: Alice herself would no longer be allowed either.
      world.entities.set(CP, { ...world.entities.get(CP)!, retirementApproved: false, version: 'f'.repeat(24) });
      await expect(agentRetire(svc, CP)).rejects.toThrow(/delegator-not-authorized/);
      expect(executor.calls).toEqual([]);
    });

    it('re-checks the grant immediately before mutation', async () => {
      const svc = make('gated');
      const g = await grant(svc, [CP]);
      let calls = 0;
      world.onResolve = async () => {
        calls += 1;
        if (calls === 2) await store.revokeGrant(g.grantId, 'user:default/alice');
      };
      await expect(agentRetire(svc, CP)).rejects.toThrow(/task-grant-revoked-before-mutation/);
      expect(executor.calls).toEqual([]);
    });

    it('a grant for one entity of a mixed location does not cover the whole location', async () => {
      const svc = make('gated');
      await rawGrant({ targets: ['component:default/checkout-lint-bot'] });
      await expect(agentRetire(svc, 'component:default/checkout-lint-bot')).rejects.toThrow(/outside-task-grant/);
      expect(executor.calls).toEqual([]);
    });

    it('only the delegator can revoke', async () => {
      const svc = make('gated');
      const g = await grant(svc, [CP]);
      await expect(svc.revokeGrant(agent, g.grantId)).rejects.toThrow(/only-the-delegator-can-revoke/);
    });
  });

  describe('ungated lab', () => {
    beforeEach(() => store.startRun('ungated-lab'));

    it('skips resource authorization, says so, and uses the same executor', async () => {
      const r = await retire(make('ungated-lab'), 'component:default/payments-api');
      expect(r.outcome).toBe('REMOVED_VERIFIED');
      expect(r.resourceAuthorization).toBe('skipped-intentionally');
      expect(permissionCalls).toEqual([]);
      const ev = await events();
      expect(ev.find(e => e.phase === 'authorization-skipped')?.decision).toBe('SKIPPED');
      expect(ev.some(e => e.decision === 'ALLOW')).toBe(false);
      expect(executor.calls).toEqual(['unregister:payments-api']);
    });

    it('still refuses targets outside the manifest', async () => {
      await expect(retire(make('ungated-lab'), 'component:default/real-prod-db')).rejects.toMatchObject({ name: 'NotFoundError' });
      expect(executor.calls).toEqual([]);
    });
  });
});
