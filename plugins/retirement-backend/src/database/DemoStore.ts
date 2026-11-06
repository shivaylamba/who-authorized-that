import crypto from 'node:crypto';
import { Knex } from 'knex';
import {
  AuthFailureEvent,
  CatalogSnapshot,
  DemoEvent,
  DemoMode,
  RetirementResult,
  RunRecord,
  RunStatus,
  TaskGrant,
} from '@internal/plugin-retirement-common';
import { ApprovalRecord } from '../classification';

const T = {
  runs: 'demo_runs',
  events: 'demo_events',
  authFailures: 'demo_auth_failures',
  operations: 'demo_operations',
  approvals: 'demo_approvals',
  artifacts: 'demo_run_artifacts',
  grants: 'demo_task_grants',
  suspensions: 'demo_suspended_principals',
};

type RunRow = {
  run_id: string;
  mode: DemoMode;
  label: string | null;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  caller_subject: string | null;
};

type GrantRow = {
  grant_id: string;
  agent_ref: string;
  delegator_ref: string;
  task_id: string;
  action: string;
  targets: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
};

export type StoredOperation = {
  operationId: string;
  runId: string;
  actionId: string;
  requestedEntityRef: string;
  result?: RetirementResult;
  error?: { name: string; message: string };
  before?: CatalogSnapshot;
  after?: CatalogSnapshot;
  createdAt: string;
};

/**
 * Keys that must never be persisted into evidence: exact credential names,
 * snake/kebab suffixes (access_token) and camelCase suffixes (refreshToken).
 * Deliberately not a substring match, so fields such as
 * `resourceAuthorization` survive.
 */
function isSecretKey(key: string): boolean {
  return (
    /^(authorization|cookie|set-cookie|password|secret|token|credentials?)$/i.test(key) ||
    /[_-](token|secret|password)$/i.test(key) ||
    /(Token|Secret|Password|Cookie|Credentials?)$/.test(key)
  );
}

/** Recursively drops secret-looking keys before anything is stored or exported. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(v => redact(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '[redacted]' : redact(v);
    }
    return out as T;
  }
  if (typeof value === 'string' && /^Bearer\s/i.test(value)) {
    return '[redacted]' as unknown as T;
  }
  return value;
}

/**
 * Local demo evidence store in the plugin database. This is a convenience
 * event table for the presentation, not an immutable compliance ledger.
 */
export class DemoStore {
  private constructor(private readonly db: Knex) {}

  static async create(db: Knex): Promise<DemoStore> {
    const store = new DemoStore(db);
    await store.migrate();
    return store;
  }

  private async migrate() {
    // A knex schema builder accumulates statements, so take a fresh one each time.
    const s = {
      hasTable: (name: string) => this.db.schema.hasTable(name),
      createTable: (name: string, cb: (t: Knex.CreateTableBuilder) => void) =>
        this.db.schema.createTable(name, cb),
    };
    if (!(await s.hasTable(T.runs))) {
      await s.createTable(T.runs, t => {
        t.string('run_id').primary();
        t.string('mode').notNullable();
        t.string('label');
        t.string('status').notNullable();
        t.string('started_at').notNullable();
        t.string('completed_at');
        t.string('caller_subject');
      });
    }
    if (!(await s.hasTable(T.events))) {
      await s.createTable(T.events, t => {
        t.increments('seq').primary();
        t.string('event_id').notNullable().unique();
        t.string('run_id').notNullable().index();
        t.string('operation_id').notNullable().index();
        t.string('timestamp').notNullable();
        t.text('body').notNullable();
      });
    }
    if (!(await s.hasTable(T.authFailures))) {
      await s.createTable(T.authFailures, t => {
        t.string('event_id').primary();
        t.string('run_id').notNullable().index();
        t.text('body').notNullable();
      });
    }
    if (!(await s.hasTable(T.operations))) {
      await s.createTable(T.operations, t => {
        t.string('operation_id').primary();
        t.string('run_id').notNullable().index();
        t.string('created_at').notNullable();
        t.text('body').notNullable();
      });
    }
    if (!(await s.hasTable(T.approvals))) {
      await s.createTable(T.approvals, t => {
        t.string('entity_ref').primary();
        t.string('approval_id').notNullable();
        t.string('approved_by').notNullable();
        t.string('seeded_at').notNullable();
      });
    }
    if (!(await s.hasTable(T.grants))) {
      await s.createTable(T.grants, t => {
        t.string('grant_id').primary();
        t.string('agent_ref').notNullable().index();
        t.string('delegator_ref').notNullable();
        t.string('task_id').notNullable();
        t.string('action').notNullable();
        t.text('targets').notNullable();
        t.string('issued_at').notNullable();
        t.string('expires_at').notNullable();
        t.string('revoked_at');
        t.string('revoked_by');
      });
    }
    if (!(await s.hasTable(T.suspensions))) {
      await s.createTable(T.suspensions, t => {
        t.string('entity_ref').primary();
        t.string('suspended_at').notNullable();
      });
    }
    if (!(await s.hasTable(T.artifacts))) {
      await s.createTable(T.artifacts, t => {
        t.string('run_id').primary();
        t.text('body').notNullable();
      });
    }
  }

  // Runs

  async startRun(mode: DemoMode, label?: string): Promise<RunRecord> {
    await this.db(T.runs)
      .where({ status: 'active' })
      .update({ status: 'abandoned', completed_at: new Date().toISOString() });
    const run: RunRecord = {
      runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
        .randomBytes(3)
        .toString('hex')}`,
      mode,
      label,
      status: 'active',
      startedAt: new Date().toISOString(),
    };
    await this.db(T.runs).insert({
      run_id: run.runId,
      mode: run.mode,
      label: run.label ?? null,
      status: run.status,
      started_at: run.startedAt,
    });
    return run;
  }

  async getActiveRun(): Promise<RunRecord | undefined> {
    const row = await this.db(T.runs)
      .where({ status: 'active' })
      .orderBy('started_at', 'desc')
      .first();
    return row ? this.toRun(row) : undefined;
  }

  /** The most recent run, active or completed; what the presenter page follows. */
  async getCurrentRun(): Promise<RunRecord | undefined> {
    const row = await this.db(T.runs).orderBy('started_at', 'desc').first();
    return row ? this.toRun(row) : undefined;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const row = await this.db(T.runs).where({ run_id: runId }).first();
    return row ? this.toRun(row) : undefined;
  }

  async listRuns(): Promise<RunRecord[]> {
    const rows = await this.db(T.runs).orderBy('started_at', 'desc').limit(50);
    return rows.map(r => this.toRun(r));
  }

  async completeRun(runId: string, status: RunStatus, callerSubject?: string) {
    await this.db(T.runs).where({ run_id: runId }).update({
      status,
      completed_at: new Date().toISOString(),
      ...(callerSubject ? { caller_subject: callerSubject } : {}),
    });
  }

  async listCompletedRuns(mode: DemoMode, limit = 50): Promise<RunRecord[]> {
    const rows = await this.db(T.runs)
      .where({ mode, status: 'completed' })
      .orderBy('completed_at', 'desc')
      .limit(limit);
    return rows.map(r => this.toRun(r));
  }

  async lastCompletedRun(mode: DemoMode): Promise<RunRecord | undefined> {
    const row = await this.db(T.runs)
      .where({ mode, status: 'completed' })
      .orderBy('completed_at', 'desc')
      .first();
    return row ? this.toRun(row) : undefined;
  }

  private toRun(row: RunRow): RunRecord {
    return {
      runId: row.run_id,
      mode: row.mode,
      label: row.label ?? undefined,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      callerSubject: row.caller_subject ?? undefined,
    };
  }

  // Events

  async appendEvent(event: DemoEvent): Promise<void> {
    await this.db(T.events).insert({
      event_id: event.eventId,
      run_id: event.runId,
      operation_id: event.operationId,
      timestamp: event.timestamp,
      body: JSON.stringify(redact(event)),
    });
  }

  async listEvents(
    runId: string,
    afterSeq = 0,
  ): Promise<Array<DemoEvent & { seq: number }>> {
    const rows = await this.db(T.events)
      .where({ run_id: runId })
      .andWhere('seq', '>', afterSeq)
      .orderBy('seq', 'asc')
      .limit(500);
    return rows.map(r => ({ ...JSON.parse(r.body), seq: r.seq }));
  }

  async appendAuthFailure(event: AuthFailureEvent): Promise<void> {
    await this.db(T.authFailures).insert({
      event_id: event.eventId,
      run_id: event.runId,
      body: JSON.stringify(redact(event)),
    });
  }

  async listAuthFailures(runId: string): Promise<AuthFailureEvent[]> {
    const rows = await this.db(T.authFailures).where({ run_id: runId });
    return rows.map(r => JSON.parse(r.body));
  }

  // Operations

  async saveOperation(op: StoredOperation): Promise<void> {
    const body = JSON.stringify(redact(op));
    const existing = await this.db(T.operations)
      .where({ operation_id: op.operationId })
      .first();
    if (existing) {
      await this.db(T.operations)
        .where({ operation_id: op.operationId })
        .update({ body });
    } else {
      await this.db(T.operations).insert({
        operation_id: op.operationId,
        run_id: op.runId,
        created_at: op.createdAt,
        body,
      });
    }
  }

  async listOperations(runId: string): Promise<StoredOperation[]> {
    const rows = await this.db(T.operations)
      .where({ run_id: runId })
      .orderBy('created_at', 'asc');
    return rows.map(r => JSON.parse(r.body));
  }

  // Run artifacts submitted by the operator replay (MCP envelopes etc.)

  async saveArtifacts(runId: string, artifacts: unknown): Promise<void> {
    const body = JSON.stringify(redact(artifacts));
    await this.db(T.artifacts).where({ run_id: runId }).delete();
    await this.db(T.artifacts).insert({ run_id: runId, body });
  }

  async getArtifacts(runId: string): Promise<unknown | undefined> {
    const row = await this.db(T.artifacts).where({ run_id: runId }).first();
    return row ? JSON.parse(row.body) : undefined;
  }

  // Approvals

  async replaceApprovals(approvals: ApprovalRecord[]): Promise<void> {
    await this.db.transaction(async tx => {
      await tx(T.approvals).delete();
      if (approvals.length) {
        await tx(T.approvals).insert(
          approvals.map(a => ({
            entity_ref: a.entityRef,
            approval_id: a.approvalId,
            approved_by: a.approvedBy,
            seeded_at: new Date().toISOString(),
          })),
        );
      }
    });
  }

  async getApproval(entityRef: string): Promise<ApprovalRecord | undefined> {
    const row = await this.db(T.approvals).where({ entity_ref: entityRef }).first();
    return row
      ? {
          entityRef: row.entity_ref,
          approvalId: row.approval_id,
          approvedBy: row.approved_by,
        }
      : undefined;
  }

  async withdrawApproval(entityRef: string): Promise<boolean> {
    return (await this.db(T.approvals).where({ entity_ref: entityRef }).delete()) > 0;
  }

  // Task grants (custom application logic)

  async createGrant(g: Omit<TaskGrant, 'status' | 'revokedAt' | 'revokedBy'>): Promise<TaskGrant> {
    await this.db(T.grants).insert({
      grant_id: g.grantId,
      agent_ref: g.agentRef,
      delegator_ref: g.delegatorRef,
      task_id: g.taskId,
      action: g.action,
      targets: JSON.stringify(g.targets),
      issued_at: g.issuedAt,
      expires_at: g.expiresAt,
    });
    return (await this.getGrant(g.grantId))!;
  }

  async getGrant(grantId: string, now = new Date()): Promise<TaskGrant | undefined> {
    const row = await this.db(T.grants).where({ grant_id: grantId }).first();
    return row ? this.toGrant(row, now) : undefined;
  }

  async listGrants(now = new Date()): Promise<TaskGrant[]> {
    const rows = await this.db(T.grants).orderBy('issued_at', 'desc').limit(50);
    return rows.map(r => this.toGrant(r, now));
  }

  async grantsForAgent(agentRef: string, now = new Date()): Promise<TaskGrant[]> {
    const rows = await this.db(T.grants).where({ agent_ref: agentRef });
    return rows.map(r => this.toGrant(r, now));
  }

  async revokeGrant(grantId: string, revokedBy: string): Promise<void> {
    await this.db(T.grants)
      .where({ grant_id: grantId })
      .whereNull('revoked_at')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy });
  }

  async revokeAllGrants(revokedBy: string): Promise<number> {
    return this.db(T.grants)
      .whereNull('revoked_at')
      .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy });
  }

  /** Operator test hook: move a grant's expiry into the past. */
  async expireGrant(grantId: string): Promise<void> {
    await this.db(T.grants)
      .where({ grant_id: grantId })
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() });
  }

  private toGrant(row: GrantRow, now: Date): TaskGrant {
    const revoked = Boolean(row.revoked_at);
    const expired = new Date(row.expires_at).getTime() <= now.getTime();
    return {
      grantId: row.grant_id,
      agentRef: row.agent_ref,
      delegatorRef: row.delegator_ref,
      taskId: row.task_id,
      action: row.action,
      targets: JSON.parse(row.targets),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
      revokedBy: row.revoked_by ?? undefined,
      status: revoked ? 'revoked' : expired ? 'expired' : 'active',
    };
  }

  // Demo identity model: operator-controlled suspension of a principal.

  async setSuspended(entityRef: string, suspended: boolean): Promise<void> {
    await this.db(T.suspensions).where({ entity_ref: entityRef }).delete();
    if (suspended) {
      await this.db(T.suspensions).insert({
        entity_ref: entityRef,
        suspended_at: new Date().toISOString(),
      });
    }
  }

  async isSuspended(entityRef: string): Promise<boolean> {
    return Boolean(await this.db(T.suspensions).where({ entity_ref: entityRef }).first());
  }

  async clearSuspensions(): Promise<void> {
    await this.db(T.suspensions).delete();
  }

  /** Separate, explicit operator action: wipes historical demo evidence only. */
  async wipeEvidence(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx(T.events).delete();
      await tx(T.authFailures).delete();
      await tx(T.operations).delete();
      await tx(T.artifacts).delete();
      await tx(T.runs).delete();
    });
  }
}
