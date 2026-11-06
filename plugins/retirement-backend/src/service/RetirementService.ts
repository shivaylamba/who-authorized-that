import crypto from 'node:crypto';
import fs from 'node:fs';
import YAML from 'yaml';
import {
  AuditorService,
  AuthService,
  BackstageCredentials,
  BackstageUserPrincipal,
  LoggerService,
  PermissionsService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import {
  ConflictError,
  InputError,
  NotAllowedError,
  NotFoundError,
} from '@backstage/errors';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { RELATION_MEMBER_OF } from '@backstage/catalog-model';
import { JsonObject } from '@backstage/types';
import {
  ACTION_NAMES,
  ANNOTATION_ACCOUNT_TYPE,
  CallerRef,
  DelegationContext,
  DemoEvent,
  DemoMode,
  RETIREMENT_PLUGIN_ID,
  RetirementOutcome,
  RetirementPreview,
  RetirementResult,
  RETIRE_ACTION_ID,
  ServiceSummary,
  TaskGrant,
  TrustedClassification,
  retirementTargetRetirePermission,
} from '@internal/plugin-retirement-common';
import {
  canDelegateRetirement,
  evaluateRetirementTarget,
} from '../permissions/evaluator';
import { explainGatedRule, toResourceRef } from '../classification';
import { DemoStore } from '../database/DemoStore';
import { ManifestGuard, canonicalEntityRef } from '../manifest';
import { KeyedLock } from './KeyedLock';
import { CatalogExecutor } from './PrivilegedCatalogExecutor';
import { AffectedSet, TargetResolver } from './TrustedResolver';

export type RetireInput = {
  entityRef: string;
  reason: string;
  expectedVersion?: string;
};

export type Channel = 'mcp' | 'ui';

export type IssueGrantInput = {
  agentRef: string;
  taskId: string;
  targets: string[];
  ttlMinutes: number;
};

type Authority =
  | { ok: true; claims: string[] }
  | { ok: false; reason: string };

/** Permission names recorded for delegated checks (custom application logic). */
const TASK_GRANT_CHECK = 'retirement-demo.task-grant';
const DELEGATOR_CHECK = 'retirement-demo.target.retire (delegator authority)';

type VerifiedCaller = {
  ref: CallerRef & { kind: 'human' | 'agent' };
  credentials: BackstageCredentials<BackstageUserPrincipal>;
  ownershipEntityRefs: string[];
};

export type RetirementServiceOptions = {
  mode: DemoMode;
  logger: LoggerService;
  auth: AuthService;
  permissions: PermissionsService;
  userInfo: UserInfoService;
  store: DemoStore;
  guard: ManifestGuard;
  resolver: TargetResolver;
  executor: CatalogExecutor;
  /** Native Backstage auditor; decisions and grant changes are emitted here too. */
  auditor?: AuditorService;
  verification?: { timeoutMs: number; intervalMs: number };
};

/** Facts collected during an operation for the native audit event. */
type AuditContext = {
  operationId?: string;
  correlationId?: string;
  caller?: CallerRef;
  delegation?: DelegationContext;
  result?: RetirementResult;
};

function auditMeta(ctx: AuditContext, executorSubject: string): JsonObject {
  return {
    operationId: ctx.operationId ?? null,
    correlationId: ctx.correlationId ?? null,
    caller: ctx.caller ? { subject: ctx.caller.subject, kind: ctx.caller.kind ?? null } : null,
    outcome: ctx.result?.outcome ?? null,
    affectedEntityRefs: ctx.result?.affectedEntityRefs ?? [],
    resourceAuthorization: ctx.result?.resourceAuthorization ?? null,
    executorSubject,
    executorAttempted: ctx.result?.executorAttempted ?? false,
    reasonCodes: ctx.result?.reasonCodes ?? [],
    delegation: ctx.delegation ? { ...ctx.delegation } : null,
  };
}

const actionId = (name: string) => `${RETIREMENT_PLUGIN_ID}:${name}`;

/**
 * The single application service behind both the MCP actions and the
 * presenter page. The two startup profiles share every line of this class
 * except the explicit branch in `authorizeAffectedSet`.
 */
export class RetirementService {
  private readonly lock = new KeyedLock();
  private readonly verification: { timeoutMs: number; intervalMs: number };

  constructor(private readonly o: RetirementServiceOptions) {
    this.verification = o.verification ?? { timeoutMs: 20_000, intervalMs: 500 };
  }

  get mode(): DemoMode {
    return this.o.mode;
  }

  get executorSubject(): string {
    return this.o.executor.subject;
  }

  /** Accepts only verified user principals; service principals are not recognized callers. */
  async verifyCaller(credentials: BackstageCredentials): Promise<VerifiedCaller> {
    if (!this.o.auth.isPrincipal(credentials, 'user')) {
      throw new NotAllowedError('caller-must-be-a-user-principal');
    }
    const info = await this.o.userInfo.getUserInfo(credentials);
    return {
      ref: {
        type: 'user',
        subject: info.userEntityRef,
        kind: await this.principalKind(info.userEntityRef),
      },
      credentials,
      ownershipEntityRefs: info.ownershipEntityRefs.map(r =>
        r.toLocaleLowerCase('en-US'),
      ),
    };
  }

  /** Trusted classification of a user principal from its catalog entity. */
  async principalKind(userEntityRef: string): Promise<'human' | 'agent'> {
    const entity = await this.o.resolver.getEntity(userEntityRef);
    return entity?.metadata.annotations?.[ANNOTATION_ACCOUNT_TYPE] === 'agent'
      ? 'agent'
      : 'human';
  }

  /**
   * The delegator's CURRENT authority, re-resolved server-side from trusted
   * data at the time of use: the User entity must exist, be a human account,
   * not be suspended in the demo identity model, and hold the retirement gate.
   * Ownership claims are the user plus direct group memberships, which is what
   * the configured sign-in resolver puts into Alice's token. The delegator's
   * own token is never needed and never fabricated.
   */
  async resolveDelegatorAuthority(delegatorRef: string): Promise<Authority> {
    const entity = await this.o.resolver.getEntity(delegatorRef).catch(() => undefined);
    if (!entity || entity.kind !== 'User') {
      return { ok: false, reason: 'delegator-not-found' };
    }
    if (entity.metadata.annotations?.[ANNOTATION_ACCOUNT_TYPE] === 'agent') {
      return { ok: false, reason: 'delegator-is-an-agent' };
    }
    if (await this.o.store.isSuspended(delegatorRef)) {
      return { ok: false, reason: 'delegator-suspended' };
    }
    const claims = [
      delegatorRef,
      ...(entity.relations ?? [])
        .filter(r => r.type === RELATION_MEMBER_OF)
        .map(r => r.targetRef.toLocaleLowerCase('en-US')),
    ];
    if (!canDelegateRetirement(claims)) {
      return { ok: false, reason: 'delegator-lacks-retirement-gate' };
    }
    return { ok: true, claims };
  }

  // Task grants (custom application logic — not native Backstage, not RFC 8693)

  async listGrants(): Promise<TaskGrant[]> {
    return this.o.store.listGrants();
  }

  /** Native audit event around grant changes (eventId `task-grant`). */
  private async auditGrant<T extends TaskGrant>(
    action: 'issue' | 'revoke',
    meta: JsonObject,
    fn: () => Promise<T>,
  ): Promise<T> {
    const audit = await this.o.auditor?.createEvent({
      eventId: 'task-grant',
      severityLevel: 'high',
      meta: { action, ...meta },
    });
    try {
      const grant = await fn();
      await audit?.success({
        meta: {
          action,
          grantId: grant.grantId,
          agentRef: grant.agentRef,
          delegatorRef: grant.delegatorRef,
          taskId: grant.taskId,
          grantAction: grant.action,
          targets: grant.targets,
          expiresAt: grant.expiresAt,
          status: grant.status,
        },
      });
      return grant;
    } catch (e) {
      await audit?.fail({ error: e as Error, meta: { action, ...meta } });
      throw e;
    }
  }

  async issueGrant(credentials: BackstageCredentials, input: IssueGrantInput): Promise<TaskGrant> {
    return this.auditGrant(
      'issue',
      { agentRef: String(input.agentRef).slice(0, 200), taskId: String(input.taskId).slice(0, 20) },
      () => this.issueGrantInner(credentials, input),
    );
  }

  async revokeGrant(credentials: BackstageCredentials, grantId: string): Promise<TaskGrant> {
    return this.auditGrant('revoke', { grantId: grantId.slice(0, 80) }, () =>
      this.revokeGrantInner(credentials, grantId),
    );
  }

  /** A human issues a grant for an agent account. The issuer comes from verified credentials only. */
  private async issueGrantInner(
    credentials: BackstageCredentials,
    input: IssueGrantInput,
  ): Promise<TaskGrant> {
    const caller = await this.verifyCaller(credentials);
    if (caller.ref.kind !== 'human') {
      throw new NotAllowedError('agents-cannot-issue-or-expand-grants');
    }
    const authority = await this.resolveDelegatorAuthority(caller.ref.subject);
    if (!authority.ok) {
      throw new NotAllowedError(authority.reason);
    }
    const agentRef = canonicalEntityRef(
      input.agentRef.includes(':') ? input.agentRef : `user:default/${input.agentRef}`,
    );
    if (!agentRef.startsWith('user:') || (await this.principalKind(agentRef)) !== 'agent') {
      throw new InputError('grantee-is-not-an-agent-account');
    }
    if (!this.o.guard.manifest.issues.some(i => i.issueId === input.taskId)) {
      throw new NotFoundError(`unknown-task: ${input.taskId}`);
    }
    if (!Number.isInteger(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > 60) {
      throw new InputError('ttlMinutes must be an integer between 1 and 60');
    }
    const targets = [...new Set(input.targets.map(t => this.requireManagedRef(t)))];
    if (targets.length === 0 || targets.length > 5) {
      throw new InputError('grant must name 1 to 5 targets');
    }
    // A delegator cannot delegate what they cannot do themselves.
    for (const target of targets) {
      const c = await this.o.resolver.classify(target);
      if (!evaluateRetirementTarget(c, authority.claims)) {
        throw new NotAllowedError(`delegator-cannot-delegate: ${target}`);
      }
    }
    const now = new Date();
    const grant = await this.o.store.createGrant({
      grantId: `grant-${crypto.randomUUID().slice(0, 8)}`,
      agentRef,
      delegatorRef: caller.ref.subject,
      taskId: input.taskId,
      action: RETIRE_ACTION_ID,
      targets,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString(),
    });
    await this.grantEvent(caller.ref, 'grant-issued', grant);
    return grant;
  }

  /** Only the human who issued a grant can revoke it through this path (the operator can too). */
  private async revokeGrantInner(
    credentials: BackstageCredentials,
    grantId: string,
  ): Promise<TaskGrant> {
    const caller = await this.verifyCaller(credentials);
    const grant = await this.o.store.getGrant(grantId);
    if (!grant) throw new NotFoundError('no-such-grant');
    if (caller.ref.kind !== 'human' || caller.ref.subject !== grant.delegatorRef) {
      throw new NotAllowedError('only-the-delegator-can-revoke');
    }
    await this.o.store.revokeGrant(grantId, caller.ref.subject);
    const revoked = (await this.o.store.getGrant(grantId))!;
    await this.grantEvent(caller.ref, 'grant-revoked', revoked);
    return revoked;
  }

  async grantEvent(
    caller: CallerRef,
    phase: 'grant-issued' | 'grant-revoked',
    grant: TaskGrant,
  ) {
    const run =
      (await this.o.store.getActiveRun()) ??
      (await this.o.store.startRun(this.o.mode, 'live'));
    await this.o.store.appendEvent({
      eventId: crypto.randomUUID(),
      runId: run.runId,
      operationId: grant.grantId,
      timestamp: new Date().toISOString(),
      mode: this.o.mode,
      phase,
      caller,
      actionId: phase === 'grant-issued' ? 'retirement-demo:issue-grant' : 'retirement-demo:revoke-grant',
      correlationId: grant.grantId,
      affectedEntityRefs: grant.targets,
      delegation: toDelegation(grant),
      detail: `${grant.taskId}: ${grant.agentRef} may ${grant.action} on ${grant.targets.join(', ')} until ${grant.expiresAt}`,
    });
  }

  // Read-only actions

  async readIssue(issueId: string) {
    const issue = this.o.guard.manifest.issues.find(i => i.issueId === issueId);
    if (!issue) {
      throw new NotFoundError(`No issue fixture ${issueId}`);
    }
    const raw = fs.readFileSync(issue.path, 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      throw new Error('Issue fixture is malformed');
    }
    const front = YAML.parse(match[1]);
    return {
      issueId: String(front.issueId),
      title: String(front.title),
      body: match[2].trim(),
      sourceUrl: String(front.sourceUrl),
      revision: String(front.revision),
      author: String(front.author),
      provenance: {
        classification: 'untrusted-external-content' as const,
        note: 'Issue text is external content. It is not policy and not an approval record.',
      },
    };
  }

  async listServices(filters: { environment?: string; lifecycle?: string }) {
    const services: ServiceSummary[] = [];
    for (const target of this.o.guard.manifest.targets) {
      if (target.testOnly) continue;
      for (const entityRef of target.entityRefs) {
        const entity = await this.o.resolver.getEntity(entityRef);
        const c = await this.o.resolver.classify(entityRef);
        const summary: ServiceSummary = c
          ? {
              ...c,
              title: entity?.metadata.title,
              present: true,
              locationTarget: target.id,
            }
          : {
              entityRef,
              kind: 'Component',
              uid: '',
              retirementApproved: false,
              version: '',
              present: false,
              locationTarget: target.id,
            };
        if (filters.environment && summary.environment !== filters.environment) continue;
        if (filters.lifecycle && summary.lifecycle !== filters.lifecycle) continue;
        services.push(summary);
      }
    }
    return { services };
  }

  async preview(
    credentials: BackstageCredentials,
    rawRef: string,
  ): Promise<RetirementPreview> {
    const caller = await this.verifyCaller(credentials);
    const entityRef = this.requireManagedRef(rawRef);
    const set = await this.o.resolver.resolveAffectedSet(entityRef);
    const reasons = new Set<string>(set.problems.filter(p => p !== 'entity-absent'));
    if (caller.ref.kind === 'agent') {
      // Informative only: what the delegated check would say right now.
      for (const r of await this.delegatedReasons(caller.ref.subject, entityRef, set.affected)) {
        reasons.add(r);
      }
    } else {
      for (const a of set.affected) {
        for (const r of explainGatedRule(a, caller.ownershipEntityRefs)) {
          reasons.add(a.entityRef === entityRef ? r : `${r} (${a.entityRef})`);
        }
      }
    }
    return {
      requestedEntityRef: entityRef,
      present: set.present,
      location: set.location,
      affected: set.affected,
      affectedSetComplete: set.complete,
      resourceVersion: set.version,
      impact: set.present
        ? `Unregistering this catalog location removes ${set.affected.length} entit${
            set.affected.length === 1 ? 'y' : 'ies'
          }: ${set.affected.map(a => a.entityRef).join(', ')}`
        : 'Entity is not currently registered in the catalog.',
      callerAssessment: {
        allowedByTrustedRule: set.present && set.complete && reasons.size === 0,
        reasons: [...reasons],
      },
    };
  }

  // Mutation

  /**
   * Wraps every retirement attempt in a native Backstage audit event
   * (eventId `retire-service`, severity high) that records success or failure
   * with the caller, outcome, executor identity and any delegation.
   */
  async retire(
    credentials: BackstageCredentials,
    input: RetireInput,
    channel: Channel,
  ): Promise<RetirementResult> {
    const ctx: AuditContext = {};
    const audit = await this.o.auditor?.createEvent({
      eventId: 'retire-service',
      severityLevel: 'high',
      meta: {
        mode: this.o.mode,
        channel,
        requestedEntityRef: String(input.entityRef).slice(0, 200),
      },
    });
    try {
      const result = await this.retireInner(credentials, input, channel, ctx);
      await audit?.success({ meta: auditMeta(ctx, this.o.executor.subject) });
      return result;
    } catch (e) {
      await audit?.fail({ error: e as Error, meta: auditMeta(ctx, this.o.executor.subject) });
      throw e;
    }
  }

  private async retireInner(
    credentials: BackstageCredentials,
    input: RetireInput,
    channel: Channel,
    ctx: AuditContext,
  ): Promise<RetirementResult> {
    // Live actions after a completed replay open a fresh run rather than
    // appending to stored historical evidence.
    const run =
      (await this.o.store.getActiveRun()) ??
      (await this.o.store.startRun(this.o.mode, 'live'));
    // The lab server lets each run choose whether the check runs; the gated
    // server is always gated whatever a run record says.
    const mode: DemoMode = this.o.mode === 'gated' ? 'gated' : run.mode;
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    ctx.operationId = operationId;
    ctx.correlationId = correlationId;
    const action = actionId(ACTION_NAMES.retireService);
    let delegation: DelegationContext | undefined;
    const emit = async (
      caller: CallerRef,
      e: Omit<
        DemoEvent,
        | 'eventId'
        | 'runId'
        | 'operationId'
        | 'timestamp'
        | 'mode'
        | 'caller'
        | 'actionId'
        | 'correlationId'
      >,
    ) =>
      this.o.store.appendEvent({
        eventId: crypto.randomUUID(),
        runId: run.runId,
        operationId,
        timestamp: new Date().toISOString(),
        mode: mode,
        caller,
        actionId: action,
        correlationId,
        ...(delegation ? { delegation } : {}),
        ...e,
      });

    // 1. Authentication was validated natively; resolve and record the principal.
    let caller: VerifiedCaller;
    try {
      caller = await this.verifyCaller(credentials);
    } catch (e) {
      const subject =
        'principal' in credentials && credentials.principal &&
        typeof (credentials.principal as { subject?: unknown }).subject === 'string'
          ? (credentials.principal as { subject: string }).subject
          : 'unknown';
      await emit(
        { type: 'service', subject },
        { phase: 'failed', reasonCode: 'caller-not-user-principal', mutationOccurred: false },
      );
      throw e;
    }
    ctx.caller = caller.ref;
    await emit(caller.ref, {
      phase: 'authenticated',
      detail: `via ${channel}; ownership claims ${caller.ownershipEntityRefs.join(', ')}`,
    });

    // 2. Canonicalize and contain the requested target.
    let entityRef: string;
    try {
      entityRef = this.requireManagedRef(input.entityRef);
    } catch (e) {
      await emit(caller.ref, {
        phase: 'failed',
        reasonCode: e instanceof InputError ? 'malformed-ref' : 'not-a-demo-target',
        mutationOccurred: false,
      });
      throw e;
    }
    const target = this.o.guard.targetForEntityRef(entityRef)!;

    // 3. Serialize per location; everything below re-resolves inside the lock.
    return this.lock.run(target.id, async () => {
      const before = await this.o.resolver.snapshot();
      const finish = async (
        outcome: RetirementOutcome,
        set: AffectedSet | undefined,
        extra: {
          reasonCodes?: string[];
          executorAttempted?: boolean;
          error?: { name: string; message: string };
        } = {},
      ): Promise<RetirementResult> => {
        const result: RetirementResult = {
          operationId,
          correlationId,
          requestedEntityRef: entityRef,
          affectedEntityRefs: set?.affected.map(a => a.entityRef) ?? [],
          outcome,
          mode: mode,
          resourceAuthorization:
            mode === 'gated' ? 'enforced' : 'skipped-intentionally',
          executorAttempted: extra.executorAttempted ?? false,
          reasonCodes: extra.reasonCodes ?? [],
          ...(delegation ? { delegation } : {}),
        };
        ctx.result = result;
        await this.o.store.saveOperation({
          operationId,
          runId: run.runId,
          actionId: action,
          requestedEntityRef: entityRef,
          result,
          error: extra.error,
          before,
          after: await this.o.resolver.snapshot(),
          createdAt: new Date().toISOString(),
        });
        return result;
      };

      const set = await this.o.resolver.resolveAffectedSet(entityRef);
      const affectedRefs = set.affected.map(a => a.entityRef);
      await emit(caller.ref, {
        phase: 'resolved',
        requestedEntityRef: entityRef,
        affectedEntityRefs: affectedRefs,
        resourceVersion: set.version,
        detail: set.location
          ? `location ${set.location.id}; problems: ${set.problems.join(', ') || 'none'}`
          : `problems: ${set.problems.join(', ')}`,
      });

      if (!set.present) {
        await emit(caller.ref, {
          phase: 'failed',
          requestedEntityRef: entityRef,
          reasonCode: 'already-absent',
          mutationOccurred: false,
        });
        return finish('ALREADY_ABSENT', set, { reasonCodes: ['already-absent'] });
      }

      if (input.expectedVersion && input.expectedVersion !== set.version) {
        await emit(caller.ref, {
          phase: 'failed',
          requestedEntityRef: entityRef,
          affectedEntityRefs: affectedRefs,
          resourceVersion: set.version,
          reasonCode: 'stale-version',
          mutationOccurred: false,
        });
        await finish('FAILED', set, { reasonCodes: ['stale-version'] });
        throw new ConflictError(
          `stale-version: expected ${input.expectedVersion}, current ${set.version}`,
        );
      }

      // 4. The only difference between profiles.
      const decision = await this.authorizeAffectedSet(mode, caller, entityRef, set, emit);
      delegation = decision.delegation;
      ctx.delegation = delegation;
      if (decision.denied) {
        await finish('DENIED', set, { reasonCodes: decision.reasonCodes });
        throw new NotAllowedError(
          `Retirement of ${entityRef} denied for ${caller.ref.subject}: ${decision.reasonCodes.join(
            '; ',
          )}`,
        );
      }
      if (!set.complete || !set.location) {
        // Ungated lab still refuses to act on a location it could not resolve.
        await emit(caller.ref, {
          phase: 'failed',
          requestedEntityRef: entityRef,
          reasonCode: 'location-unresolved',
          mutationOccurred: false,
        });
        await finish('FAILED', set, { reasonCodes: set.problems });
        throw new ConflictError(`Cannot resolve the location for ${entityRef}`);
      }

      // 5. Recheck the version immediately before the downstream mutation.
      const recheck = await this.o.resolver.resolveAffectedSet(entityRef);
      if (recheck.version !== set.version) {
        await emit(caller.ref, {
          phase: 'failed',
          requestedEntityRef: entityRef,
          resourceVersion: recheck.version,
          reasonCode: 'changed-before-mutation',
          mutationOccurred: false,
        });
        await finish('FAILED', recheck, { reasonCodes: ['changed-before-mutation'] });
        throw new ConflictError('Target changed before mutation; nothing was removed');
      }

      // 5b. Agents: the grant and the delegator's authority are re-checked
      // immediately before mutation. A revocation that lands after this point
      // cannot stop the in-flight catalog call (documented limit).
      if (delegation && mode === 'gated') {
        const grant = await this.o.store.getGrant(delegation.grantId);
        const authority = await this.resolveDelegatorAuthority(delegation.delegatorRef);
        const reason =
          grant?.status !== 'active'
            ? `task-grant-${grant?.status ?? 'missing'}-before-mutation`
            : !authority.ok
            ? `${authority.reason}-before-mutation`
            : recheck.affected.every(a => evaluateRetirementTarget(a, authority.claims))
            ? undefined
            : 'delegator-authority-changed-before-mutation';
        if (reason) {
          await emit(caller.ref, {
            phase: 'denied',
            requestedEntityRef: entityRef,
            permissionName: TASK_GRANT_CHECK,
            decision: 'DENY',
            reasonCode: reason,
            mutationOccurred: false,
          });
          await finish('DENIED', recheck, { reasonCodes: [reason] });
          throw new NotAllowedError(`Retirement of ${entityRef} denied for ${caller.ref.subject}: ${reason}`);
        }
      }

      // 6. Privileged executor.
      await emit(caller.ref, {
        phase: 'executor-attempted',
        executorSubject: this.o.executor.subject,
        requestedEntityRef: entityRef,
        affectedEntityRefs: affectedRefs,
        resourceVersion: set.version,
        detail: `unregister location ${set.location.id}; reason: ${input.reason}`,
      });
      try {
        await this.o.executor.unregisterLocation(set.location);
      } catch (e) {
        const err = e as Error;
        await emit(caller.ref, {
          phase: 'failed',
          executorSubject: this.o.executor.subject,
          requestedEntityRef: entityRef,
          reasonCode: 'executor-failed',
          detail: `${err.name}: ${err.message}`,
          mutationOccurred: false,
        });
        await finish('FAILED', set, {
          executorAttempted: true,
          reasonCodes: ['executor-failed'],
          error: { name: err.name, message: err.message },
        });
        throw e;
      }
      await emit(caller.ref, {
        phase: 'executor-succeeded',
        executorSubject: this.o.executor.subject,
        requestedEntityRef: entityRef,
        affectedEntityRefs: affectedRefs,
        mutationOccurred: true,
      });

      // 7. Independent read-back.
      const verified = await this.waitForAbsence(affectedRefs);
      if (verified) {
        await emit(caller.ref, {
          phase: 'verification-succeeded',
          requestedEntityRef: entityRef,
          affectedEntityRefs: affectedRefs,
          mutationOccurred: true,
          detail: 'catalog read-back confirms every affected entity is absent',
        });
        return finish('REMOVED_VERIFIED', set, { executorAttempted: true });
      }
      await emit(caller.ref, {
        phase: 'failed',
        requestedEntityRef: entityRef,
        affectedEntityRefs: affectedRefs,
        reasonCode: 'verification-timeout',
        mutationOccurred: true,
      });
      return finish('UNVERIFIED', set, {
        executorAttempted: true,
        reasonCodes: ['verification-timeout'],
      });
    });
  }

  /**
   * Gated: every affected entity needs a final ALLOW from the permission
   * framework, using the original caller's credentials. Any error, CONDITIONAL
   * or incomplete set denies before mutation.
   *
   * Ungated lab: deliberately records that no resource check ran.
   */
  private async authorizeAffectedSet(
    mode: DemoMode,
    caller: VerifiedCaller,
    entityRef: string,
    set: AffectedSet,
    emit: (c: CallerRef, e: Partial<DemoEvent> & { phase: DemoEvent['phase'] }) => Promise<void>,
  ): Promise<{ denied: boolean; reasonCodes: string[]; delegation?: DelegationContext }> {
    const permissionName = retirementTargetRetirePermission.name;

    if (mode === 'ungated-lab') {
      await emit(caller.ref, {
        phase: 'authorization-skipped',
        requestedEntityRef: entityRef,
        affectedEntityRefs: set.affected.map(a => a.entityRef),
        resourceVersion: set.version,
        decision: 'SKIPPED',
        reasonCode: 'resource-authorization-skipped-intentionally',
        detail: 'INTENTIONALLY UNSAFE LAB: no affected-resource check ran',
      });
      return { denied: false, reasonCodes: [] };
    }

    if (!set.complete || set.affected.length === 0) {
      const reasonCodes = set.problems.length ? set.problems : ['affected-set-empty'];
      await emit(caller.ref, {
        phase: 'denied',
        requestedEntityRef: entityRef,
        affectedEntityRefs: set.affected.map(a => a.entityRef),
        permissionName,
        decision: 'DENY',
        reasonCode: reasonCodes.join(','),
        mutationOccurred: false,
      });
      return { denied: true, reasonCodes };
    }

    // Act 3: an agent account acts only inside a task grant, and only within
    // the delegator's current authority (shared evaluator).
    if (caller.ref.kind === 'agent') {
      return this.authorizeDelegated(caller, entityRef, set, emit);
    }

    let results: Array<{ result: AuthorizeResult }>;
    try {
      results = await this.o.permissions.authorize(
        set.affected.map(a => ({
          permission: retirementTargetRetirePermission,
          resourceRef: toResourceRef(a),
        })),
        { credentials: caller.credentials },
      );
      if (results.length !== set.affected.length) {
        throw new Error('permission response length mismatch');
      }
    } catch (e) {
      await emit(caller.ref, {
        phase: 'denied',
        requestedEntityRef: entityRef,
        affectedEntityRefs: set.affected.map(a => a.entityRef),
        permissionName,
        decision: 'DENY',
        reasonCode: 'permission-service-error',
        detail: (e as Error).name,
        mutationOccurred: false,
      });
      return { denied: true, reasonCodes: ['permission-service-error'] };
    }

    const reasonCodes: string[] = [];
    for (const [i, a] of set.affected.entries()) {
      const allowed = results[i].result === AuthorizeResult.ALLOW;
      const why = allowed ? [] : explainGatedRule(a, caller.ownershipEntityRefs);
      if (!allowed) {
        reasonCodes.push(
          `${a.entityRef}: ${why.length ? why.join(',') : 'policy-deny'}`,
        );
      }
      await emit(caller.ref, {
        phase: allowed ? 'authorized' : 'denied',
        requestedEntityRef: entityRef,
        affectedEntityRefs: [a.entityRef],
        resourceVersion: a.version,
        permissionName,
        decision: allowed ? 'ALLOW' : 'DENY',
        reasonCode: allowed ? undefined : why.join(',') || 'policy-deny',
        mutationOccurred: false,
      });
    }
    return { denied: reasonCodes.length > 0, reasonCodes };
  }

  /** Grants of this agent for the retire action that cover every affected entity. */
  private async coveringGrants(agentRef: string, entityRef: string, affectedRefs: string[]) {
    const grants = await this.o.store.grantsForAgent(agentRef);
    const forAction = grants.filter(g => g.action === RETIRE_ACTION_ID);
    const covering = forAction.filter(
      g => g.targets.includes(entityRef) && affectedRefs.every(r => g.targets.includes(r)),
    );
    const active = covering.find(g => g.status === 'active');
    let reason: string | undefined;
    if (!active) {
      // Explain against the agent's ACTIVE grants first; only fall back to
      // historical (revoked/expired) grants when nothing is active.
      if (forAction.some(g => g.status === 'active')) reason = 'outside-task-grant';
      else if (grants.some(g => g.status === 'active')) reason = 'grant-is-for-another-action';
      else {
        // Report the state of the most recently issued covering grant.
        // Grants cleared by a fixture reset are lab housekeeping, not a
        // revocation the delegator made, so they don't count as history.
        const latest = [...covering].filter(g => g.revokedBy !== 'operator-reset').sort((x, y) => y.issuedAt.localeCompare(x.issuedAt))[0];
        reason = latest ? `task-grant-${latest.status}` : 'no-task-grant';
      }
    }
    return { active, reason };
  }

  private async delegatedReasons(
    agentRef: string,
    entityRef: string,
    affected: TrustedClassification[],
  ): Promise<string[]> {
    const { active, reason } = await this.coveringGrants(
      agentRef,
      entityRef,
      affected.map(a => a.entityRef),
    );
    if (!active) return [reason!];
    const authority = await this.resolveDelegatorAuthority(active.delegatorRef);
    if (!authority.ok) return [authority.reason];
    return affected
      .filter(a => !evaluateRetirementTarget(a, authority.claims))
      .map(a => `delegator-not-authorized (${a.entityRef})`);
  }

  private async authorizeDelegated(
    caller: VerifiedCaller,
    entityRef: string,
    set: AffectedSet,
    emit: (c: CallerRef, e: Partial<DemoEvent> & { phase: DemoEvent['phase'] }) => Promise<void>,
  ): Promise<{ denied: boolean; reasonCodes: string[]; delegation?: DelegationContext }> {
    const affectedRefs = set.affected.map(a => a.entityRef);
    const { active, reason } = await this.coveringGrants(caller.ref.subject, entityRef, affectedRefs);
    if (!active) {
      await emit(caller.ref, {
        phase: 'denied',
        requestedEntityRef: entityRef,
        affectedEntityRefs: affectedRefs,
        permissionName: TASK_GRANT_CHECK,
        decision: 'DENY',
        reasonCode: reason,
        mutationOccurred: false,
        detail: 'custom task-grant check (application logic)',
      });
      return { denied: true, reasonCodes: [reason!] };
    }
    const delegation = toDelegation(active);
    await emit(caller.ref, {
      phase: 'authorized',
      requestedEntityRef: entityRef,
      affectedEntityRefs: affectedRefs,
      permissionName: TASK_GRANT_CHECK,
      decision: 'ALLOW',
      delegation,
      detail: `grant ${active.grantId} from ${active.delegatorRef} for ${active.taskId}, expires ${active.expiresAt}`,
    });

    const authority = await this.resolveDelegatorAuthority(active.delegatorRef);
    if (!authority.ok) {
      await emit(caller.ref, {
        phase: 'denied',
        requestedEntityRef: entityRef,
        permissionName: DELEGATOR_CHECK,
        decision: 'DENY',
        reasonCode: authority.reason,
        delegation,
        mutationOccurred: false,
      });
      return { denied: true, reasonCodes: [authority.reason], delegation };
    }
    const reasonCodes: string[] = [];
    for (const a of set.affected) {
      const allowed = evaluateRetirementTarget(a, authority.claims);
      if (!allowed) {
        reasonCodes.push(
          `${a.entityRef}: delegator-not-authorized (${explainGatedRule(a, authority.claims).join(',')})`,
        );
      }
      await emit(caller.ref, {
        phase: allowed ? 'authorized' : 'denied',
        requestedEntityRef: entityRef,
        affectedEntityRefs: [a.entityRef],
        resourceVersion: a.version,
        permissionName: DELEGATOR_CHECK,
        decision: allowed ? 'ALLOW' : 'DENY',
        reasonCode: allowed ? undefined : explainGatedRule(a, authority.claims).join(','),
        delegation,
        mutationOccurred: false,
      });
    }
    return { denied: reasonCodes.length > 0, reasonCodes, delegation };
  }

  private requireManagedRef(rawRef: string): string {
    const entityRef = canonicalEntityRef(rawRef);
    if (!this.o.guard.isManagedEntityRef(entityRef)) {
      throw new NotFoundError(`not-a-demo-target: ${entityRef}`);
    }
    return entityRef;
  }

  private async waitForAbsence(refs: string[]): Promise<boolean> {
    const deadline = Date.now() + this.verification.timeoutMs;
    while (Date.now() < deadline) {
      const present = await Promise.all(
        refs.map(r => this.o.resolver.getEntity(r).then(Boolean)),
      );
      if (present.every(p => !p)) return true;
      await new Promise(r => setTimeout(r, this.verification.intervalMs));
    }
    return false;
  }

  // Operator-only

  /** Restores only manifest targets. Never touches org, auth or evidence. */
  async resetFixtures(): Promise<{
    registered: string[];
    alreadyPresent: string[];
    missingAfterWait: string[];
  }> {
    await this.o.store.replaceApprovals(this.o.guard.manifest.approvals);
    await this.o.store.revokeAllGrants('operator-reset');
    await this.o.store.clearSuspensions();
    const registered: string[] = [];
    const alreadyPresent: string[] = [];
    for (const target of this.o.guard.manifest.targets) {
      await this.lock.run(target.id, async () => {
        const existing = await this.o.resolver.findLocationForTarget(
          target.locationTarget,
        );
        if (existing) {
          alreadyPresent.push(target.id);
        } else {
          await this.o.executor.registerLocation(target);
          registered.push(target.id);
        }
      });
    }
    const deadline = Date.now() + 30_000;
    let missing = this.o.guard.allManagedEntityRefs();
    while (Date.now() < deadline && missing.length) {
      const present = await Promise.all(
        missing.map(r => this.o.resolver.getEntity(r).then(Boolean)),
      );
      missing = missing.filter((_, i) => !present[i]);
      if (missing.length) await new Promise(r => setTimeout(r, 500));
    }
    this.o.logger.info(
      `Fixture reset: registered=${registered.join(',') || 'none'} missing=${
        missing.join(',') || 'none'
      }`,
    );
    return { registered, alreadyPresent, missingAfterWait: missing };
  }
}

function toDelegation(g: TaskGrant): DelegationContext {
  return {
    agentRef: g.agentRef,
    delegatorRef: g.delegatorRef,
    grantId: g.grantId,
    taskId: g.taskId,
    targets: g.targets,
    expiresAt: g.expiresAt,
  };
}
