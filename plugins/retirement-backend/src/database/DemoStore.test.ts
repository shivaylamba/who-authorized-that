import knexFactory from 'knex';
import { DemoStore, redact } from './DemoStore';

describe('redact', () => {
  it('removes secret-looking keys and bearer values at any depth', () => {
    const input = {
      caller: { type: 'user', subject: 'user:default/alice' },
      headers: { Authorization: 'Bearer SENTINEL1', cookie: 'SENTINEL2' },
      nested: [{ access_token: 'SENTINEL3', refreshToken: 'SENTINEL4', note: 'Bearer SENTINEL5' }],
      clientSecret: 'SENTINEL6',
      detail: 'safe text',
      resourceAuthorization: 'enforced',
      tokenCount: 3,
    };
    const out = redact(input);
    expect(JSON.stringify(out)).not.toMatch(/SENTINEL/);
    expect(out.caller.subject).toBe('user:default/alice');
    expect(out.detail).toBe('safe text');
    expect(out.resourceAuthorization).toBe('enforced');
    expect(out.tokenCount).toBe(3);
  });
});

describe('DemoStore', () => {
  const db = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  afterAll(() => db.destroy());

  it('migrates idempotently and keeps one active run', async () => {
    const store = await DemoStore.create(db);
    await DemoStore.create(db);
    const a = await store.startRun('gated', 'a');
    const b = await store.startRun('gated', 'b');
    expect((await store.getActiveRun())?.runId).toBe(b.runId);
    expect((await store.getRun(a.runId))?.status).toBe('abandoned');
  });

  it('wipes evidence only on the explicit wipe call and keeps approvals', async () => {
    const store = await DemoStore.create(db);
    await store.replaceApprovals([
      { entityRef: 'component:default/x', approvalId: 'C', approvedBy: 'group:default/t' },
    ]);
    const run = await store.startRun('gated');
    await store.appendEvent({
      eventId: 'e1',
      runId: run.runId,
      operationId: 'o1',
      timestamp: new Date().toISOString(),
      mode: 'gated',
      phase: 'authenticated',
      caller: { type: 'user', subject: 'user:default/alice' },
      actionId: 'retirement-demo:retire-service',
      correlationId: 'c1',
    });
    expect(await store.listEvents(run.runId)).toHaveLength(1);
    await store.wipeEvidence();
    expect(await store.listEvents(run.runId)).toHaveLength(0);
    expect(await store.getApproval('component:default/x')).toBeDefined();
  });
});
