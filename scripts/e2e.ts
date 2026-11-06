/**
 * Live acceptance suite against the running backend in its current profile.
 * Everything here goes through real HTTP, the native MCP endpoint, the real
 * permission backend and the real catalog. Run it once per profile:
 *
 *   yarn demo:start:gated   && yarn demo:test:e2e
 *   yarn demo:start:ungated && yarn demo:test:e2e
 *
 * Requires CLI logins for alice and bob (`yarn demo:login alice|bob`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_URL, EVIDENCE_DIR, ROOT, STATE_DIR, loadEnv, log, requireEnv, writeJson } from './lib/env';
import { printToken, unverifiedClaims } from './lib/cliAuth';
import { exportRun, getHealth, getSnapshot, operator, resetFixtures } from './lib/operator';
import { callTool, connect, discoverTools } from './lib/mcp';
import { RunRecord, UntypedJson, executorAttempts } from './lib/types';
import type { RetirementPreview, RetirementResult } from '@internal/plugin-retirement-common';
import { runReplay } from './replay';

type Mode = 'gated' | 'ungated-lab';
type Result = { id: string; ac: string[]; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string };
type Test = {
  id: string;
  ac: string[];
  profiles?: Mode[];
  fn: (ctx: Ctx) => Promise<string>;
};
type Ctx = { mode: Mode; alice: string; bob: string; agent: string; operatorToken: string };

const P = 'component:default/payments-api';
const C = 'component:default/checkout-preview';
const V2 = 'component:default/checkout-v2';
const LINT = 'component:default/checkout-lint-bot';
const SANDBOX = 'component:default/payments-ledger-sandbox';
const LEGACY = 'component:default/legacy-checkout-worker';
const AGENT = 'user:default/mig42-agent';
const MCP_DEFAULT = '/api/mcp-actions/v1';
const MCP_NAMED = '/api/mcp-actions/v1/retirement';
const RETIRE_TOOL = 'retirement-demo.retire-service';

/** Thrown by a test that cannot run yet (recorded as SKIP with the reason). */
class Skip extends Error {}

/**
 * Expired-credential probe. Backstage access tokens live 1 hour and cannot be
 * minted already-expired, so each suite run saves Alice's current token here
 * (VM-local, mode 0600, gitignored) and a later run asserts it is rejected
 * once its real expiry has passed. Used tokens are deleted.
 */
const EXPIRY_PROBE = path.join(STATE_DIR, 'expiry-probe.json');
type ProbeToken = { instance: string; token: string; exp: number };

function readProbes(): ProbeToken[] {
  try {
    return JSON.parse(fs.readFileSync(EXPIRY_PROBE, 'utf8'));
  } catch {
    return [];
  }
}

function writeProbes(probes: ProbeToken[]) {
  fs.writeFileSync(EXPIRY_PROBE, JSON.stringify(probes), { mode: 0o600 });
}

function captureProbe(instance: string, token: string) {
  const exp = Number(unverifiedClaims(token).exp);
  const probes = readProbes();
  if (!probes.some(p => p.exp === exp && p.instance === instance)) {
    writeProbes([...probes, { instance, token, exp }]);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function http(method: string, p: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BACKEND_URL}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: UntypedJson;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function present(ref: string): Promise<boolean> {
  const snap = await getSnapshot();
  return snap.entities.find(e => e.entityRef === ref)?.present ?? false;
}

async function snapshot() {
  return getSnapshot();
}

async function executorAttemptsFor(ref: string): Promise<number> {
  const h = await getHealth();
  if (!h.currentRun) throw new Error('no current run');
  return executorAttempts(await exportRun(h.currentRun.runId), ref);
}

async function mcpCall(token: string, endpoint: string, tool: string, args: Record<string, unknown>) {
  const s = await connect(token, endpoint);
  try {
    return await callTool(s, tool, tool, args);
  } finally {
    await s.close();
  }
}

/** Raw MCP initialize, to observe transport-level auth failures. */
async function rawInitialize(authorization?: string) {
  return http(
    'POST',
    MCP_DEFAULT,
    undefined,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
    },
    {
      Accept: 'application/json, text/event-stream',
      ...(authorization ? { Authorization: authorization } : {}),
    },
  );
}

const tests: Test[] = [
  // AC-03 anonymous / malformed credentials
  {
    id: 'anonymous-mcp-rejected',
    ac: ['AC-03'],
    fn: async () => {
      const r = await rawInitialize();
      assert(r.status === 401, `expected 401, got ${r.status}`);
      return 'MCP initialize without credentials -> 401';
    },
  },
  {
    id: 'malformed-and-forged-tokens-rejected',
    ac: ['AC-03', 'AC-09'],
    fn: async ({ alice }) => {
      const malformed = await rawInitialize('Bearer not-a-token');
      const [h, , sig] = alice.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: 'user:default/carol', ent: ['group:default/payments-team'], exp: 4102444800 }),
      ).toString('base64url');
      const forged = await rawInitialize(`Bearer ${h}.${forgedPayload}.${sig}`);
      const unsigned = await rawInitialize(
        `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${forgedPayload}.`,
      );
      for (const [name, r] of Object.entries({ malformed, forged, unsigned })) {
        assert(r.status === 401, `${name}: expected 401, got ${r.status}`);
      }
      return 'malformed, re-signed-payload and alg:none tokens -> 401';
    },
  },
  {
    id: 'anonymous-plugin-routes-rejected',
    ac: ['AC-03'],
    fn: async () => {
      const ui = await http('POST', '/api/retirement-demo/ui/retire', undefined, { entityRef: P, reason: 'x' });
      const act = await http('POST', '/api/retirement-demo/.backstage/actions/v1/actions/retirement-demo:retire-service/invoke', undefined, { entityRef: P, reason: 'x' });
      assert(ui.status === 401, `ui route: ${ui.status}`);
      assert(act.status === 401, `actions route: ${act.status}`);
      assert(await present(P), 'payments-api must remain');
      return 'UI and native actions routes without credentials -> 401; payments-api present';
    },
  },
  // AC-07 action-level gate
  {
    id: 'bob-lacks-action-gate',
    ac: ['AC-07'],
    fn: async ({ bob }) => {
      const s = await connect(bob, MCP_DEFAULT);
      const { tools } = await discoverTools(s);
      await s.close();
      const names = tools.map(t => t.name);
      assert(!names.includes(RETIRE_TOOL), `retire tool visible to bob: ${names}`);
      assert(names.includes('retirement-demo.read-issue'), 'bob should still see read tools');
      const env = await mcpCall(bob, MCP_DEFAULT, RETIRE_TOOL, { entityRef: P, reason: 'x' });
      assert(env.isError && /NotFoundError/.test(env.text.join(' ')), `unexpected: ${JSON.stringify(env)}`);
      const direct = await http(
        'POST',
        '/api/retirement-demo/.backstage/actions/v1/actions/retirement-demo:retire-service/invoke',
        bob,
        { entityRef: P, reason: 'x' },
      );
      assert(direct.status === 404, `direct invoke as bob: ${direct.status}`);
      assert(await present(P), 'payments-api must remain');
      return `tools/list for bob: [${names.join(', ')}]; tools/call -> "${env.text.join(' ')}"; direct invoke -> 404`;
    },
  },
  // AC-09 spoofing / schema
  {
    id: 'schema-rejects-authority-fields',
    ac: ['AC-09'],
    fn: async ({ alice }) => {
      const attempts: Record<string, Record<string, unknown>> = {
        owner: { entityRef: P, reason: 'x', owner: 'group:default/checkout-team' },
        approved: { entityRef: P, reason: 'x', approved: true },
        mode: { entityRef: P, reason: 'x', mode: 'ungated-lab' },
        principal: { entityRef: P, reason: 'x', principal: 'user:default/carol' },
        groups: { entityRef: P, reason: 'x', groups: ['group:default/payments-team'] },
        permissionDecision: { entityRef: P, reason: 'x', permissionDecision: 'ALLOW' },
        locationId: { entityRef: P, reason: 'x', locationId: 'x' },
        environment: { entityRef: P, reason: 'x', environment: 'development' },
        url: { entityRef: 'https://example.com/catalog-info.yaml', reason: 'x' },
        path: { entityRef: 'file:/etc/passwd', reason: 'x' },
        unknownRef: { entityRef: 'component:default/prod-database', reason: 'x' },
        longReason: { entityRef: P, reason: 'x'.repeat(501) },
      };
      const out: string[] = [];
      for (const [name, args] of Object.entries(attempts)) {
        const env = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, args);
        assert(env.isError, `${name} was accepted: ${JSON.stringify(env.structuredContent)}`);
        out.push(`${name}: ${env.text.join(' ').split(':')[0]}`);
      }
      assert(await present(P), 'payments-api must remain');
      return out.join('; ');
    },
  },
  {
    id: 'spoofed-identity-headers-ignored',
    ac: ['AC-09', 'AC-04'],
    fn: async ({ alice }) => {
      const r = await http('GET', '/api/retirement-demo/status', alice, undefined, {
        'x-backstage-user': 'user:default/carol',
        'x-forwarded-user': 'user:default/carol',
        'x-groups': 'group:default/payments-team',
      });
      assert(r.status === 200, `status ${r.status}`);
      assert(r.json.caller.userEntityRef === 'user:default/alice', `caller ${r.json.caller.userEntityRef}`);
      assert(!r.json.caller.ownershipEntityRefs.includes('group:default/payments-team'), 'spoofed group accepted');
      return `caller stays ${r.json.caller.userEntityRef} with claims ${r.json.caller.ownershipEntityRefs.join(', ')}`;
    },
  },
  {
    id: 'tool-output-is-profile-neutral',
    ac: ['AC-04', 'AC-15'],
    fn: async ({ alice }) => {
      // A live model must not be able to tell the profiles apart from tool output.
      const outs = [
        await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.read-issue', { issueId: 'MIG-42' }),
        await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.list-services', {}),
        await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.preview-retirement', { entityRef: C }),
        await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.preview-retirement', { entityRef: P }),
      ];
      const s = await connect(alice, MCP_DEFAULT);
      const { tools } = await discoverTools(s);
      await s.close();
      const blob = JSON.stringify({ outs: outs.map(o => o.text), tools });
      const leak = blob.match(/ungated|gated|\blab\b|skipped|enforced/i);
      assert(!leak, `profile leaks into tool output/schema: "${leak?.[0]}"`);
      return 'read-issue, list-services, preview and tool schemas contain no profile terms';
    },
  },
  {
    id: 'expired-credential-rejected',
    ac: ['AC-03', 'AC-18'],
    fn: async () => {
      const now = Date.now();
      const probes = readProbes();
      const expired = probes.filter(p => p.exp * 1000 < now - 5000);
      if (!expired.length) {
        const next = probes.map(p => p.exp).sort()[0];
        throw new Skip(
          next
            ? `no captured token has expired yet; next expires ${new Date(next * 1000).toISOString()}`
            : 'no token captured yet',
        );
      }
      const out: string[] = [];
      for (const p of expired) {
        const mcp = await rawInitialize(`Bearer ${p.token}`);
        const catalog = await http('GET', '/api/catalog/entities?limit=1', p.token);
        const plugin = await http('GET', '/api/retirement-demo/status', p.token);
        assert(mcp.status === 401, `expired token on MCP: ${mcp.status}`);
        assert(catalog.status === 401, `expired token on catalog: ${catalog.status}`);
        assert(plugin.status === 401, `expired token on retirement plugin: ${plugin.status}`);
        out.push(
          `${p.instance} token expired ${new Date(p.exp * 1000).toISOString()}: MCP ${mcp.status}, catalog ${catalog.status}, plugin ${plugin.status}`,
        );
      }
      writeProbes(probes.filter(p => !expired.includes(p)));
      return out.join('; ');
    },
  },
  // AC-11 alternate routes
  {
    id: 'native-catalog-mutations-denied-for-alice',
    ac: ['AC-11'],
    fn: async ({ alice }) => {
      const snap = await snapshot();
      const payTarget = path.join(ROOT, 'fixtures/targets/payments-api.yaml');
      const loc = snap.locations.find(l => l.target === payTarget);
      const uid = snap.entities.find(e => e.entityRef === P)?.uid;
      assert(loc && uid, 'payments-api location/uid not found; reset first');
      const results = {
        deleteLocation: await http('DELETE', `/api/catalog/locations/${loc.id}`, alice),
        deleteEntity: await http('DELETE', `/api/catalog/entities/by-uid/${uid}`, alice),
        createLocation: await http('POST', '/api/catalog/locations', alice, { type: 'file', target: payTarget }),
        refresh: await http('POST', '/api/catalog/refresh', alice, { entityRef: P }),
        nativeUnregisterAction: await http(
          'POST',
          '/api/catalog/.backstage/actions/v1/actions/catalog:unregister-entity/invoke',
          alice,
          { type: { locationId: loc.id } },
        ),
      };
      const summary = Object.entries(results).map(([k, v]) => `${k} -> ${v.status}`);
      for (const [k, v] of Object.entries(results)) {
        assert(v.status === 403 || v.status === 404, `${k} returned ${v.status}`);
      }
      assert(await present(P), 'payments-api must remain');
      return summary.join('; ');
    },
  },
  {
    id: 'mcp-exposes-only-demo-actions',
    ac: ['AC-11'],
    fn: async ({ alice }) => {
      const out: string[] = [];
      for (const endpoint of [MCP_DEFAULT, MCP_NAMED]) {
        const s = await connect(alice, endpoint);
        const { tools } = await discoverTools(s);
        await s.close();
        const names = tools.map(t => t.name);
        assert(names.every(n => n.startsWith('retirement-demo.')), `${endpoint} exposes ${names}`);
        const env = await mcpCall(alice, endpoint, 'catalog.unregister-entity', { type: { locationId: 'x' } });
        assert(env.isError && /NotFoundError/.test(env.text.join(' ')), `catalog tool callable on ${endpoint}`);
        out.push(`${endpoint}: [${names.join(', ')}]; catalog.unregister-entity -> ${env.text.join(' ')}`);
      }
      return out.join(' | ');
    },
  },
  {
    id: 'operator-and-service-boundaries',
    ac: ['AC-11', 'AC-18'],
    fn: async ({ alice, operatorToken }) => {
      const aliceOperator = await http('POST', '/api/retirement-demo/operator/reset', alice, {});
      const opOnMcp = await rawInitialize(`Bearer ${operatorToken}`);
      const opOnCatalog = await http('GET', '/api/catalog/entities?limit=1', operatorToken);
      const opInvokesRetire = await http(
        'POST',
        '/api/retirement-demo/.backstage/actions/v1/actions/retirement-demo:retire-service/invoke',
        operatorToken,
        { entityRef: C, reason: 'service principal attempt' },
      );
      assert(aliceOperator.status === 403 || aliceOperator.status === 401, `alice on operator route: ${aliceOperator.status}`);
      assert(opOnMcp.status === 401 || opOnMcp.status === 403, `operator token on MCP: ${opOnMcp.status}`);
      assert(opOnCatalog.status === 401 || opOnCatalog.status === 403, `operator token on catalog: ${opOnCatalog.status}`);
      assert(opInvokesRetire.status === 403, `service principal invoking retire: ${opInvokesRetire.status}`);
      assert(await present(C), 'checkout-preview must remain');
      return `alice->operator ${aliceOperator.status}; operator->MCP ${opOnMcp.status}; operator->catalog ${opOnCatalog.status}; operator(service)->retire ${opInvokesRetire.status} (${opInvokesRetire.json?.error?.message})`;
    },
  },
  {
    id: 'executor-credential-is-framework-restricted',
    ac: ['AC-11', 'AC-18'],
    fn: async () => {
      const t = requireEnv('DEMO_EXECUTOR_TOKEN');
      const snap = await snapshot();
      const uid = snap.entities.find(e => e.entityRef === P)?.uid;
      const r = {
        readEntities: await http('GET', '/api/catalog/entities?limit=1', t),
        readLocations: await http('GET', '/api/catalog/locations', t),
        deleteEntity: await http('DELETE', `/api/catalog/entities/by-uid/${uid}`, t),
        refresh: await http('POST', '/api/catalog/refresh', t, { entityRef: P }),
        analyzeLocation: await http('POST', '/api/catalog/analyze-location', t, { location: { type: 'file', target: '/etc/hosts' } }),
        mcp: await rawInitialize(`Bearer ${t}`),
        retirementPlugin: await http('GET', '/api/retirement-demo/targets', t),
        permissionBackend: await http('POST', '/api/permission/authorize', t, { items: [] }),
      };
      assert(r.readEntities.status === 200, `read entities ${r.readEntities.status}`);
      assert(r.readLocations.status === 200, `read locations ${r.readLocations.status}`);
      for (const k of ['deleteEntity', 'refresh', 'analyzeLocation'] as const) {
        assert(r[k].status === 403, `${k} returned ${r[k].status} (must be denied by accessRestrictions)`);
      }
      for (const k of ['mcp', 'retirementPlugin', 'permissionBackend'] as const) {
        assert(r[k].status === 401 || r[k].status === 403, `${k} returned ${r[k].status}`);
      }
      assert(await present(P), 'payments-api must remain');
      return Object.entries(r).map(([k, v]) => `${k} -> ${v.status}`).join('; ');
    },
  },
  // Gated-only denials that would mutate in the lab
  {
    id: 'direct-routes-do-not-bypass-gate',
    ac: ['AC-11'],
    profiles: ['gated'],
    fn: async ({ alice }) => {
      const nativeInvoke = await http(
        'POST',
        '/api/retirement-demo/.backstage/actions/v1/actions/retirement-demo:retire-service/invoke',
        alice,
        { entityRef: P, reason: 'direct' },
      );
      const ui = await http('POST', '/api/retirement-demo/ui/retire', alice, { entityRef: P, reason: 'direct' });
      const named = await mcpCall(alice, MCP_NAMED, RETIRE_TOOL, { entityRef: P, reason: 'named endpoint' });
      assert(nativeInvoke.status === 403, `native invoke ${nativeInvoke.status}`);
      assert(ui.status === 403, `ui route ${ui.status}`);
      assert(named.isError && /NotAllowedError/.test(named.text.join(' ')), `named endpoint: ${named.text}`);
      assert(await present(P), 'payments-api must remain');
      assert((await executorAttemptsFor(P)) === 0, 'executor attempted for payments');
      return `actions route 403; UI route 403; named MCP endpoint -> ${named.text.join(' ').slice(0, 80)}…; executor attempts 0`;
    },
  },
  {
    id: 'ownership-alone-insufficient',
    ac: ['AC-08'],
    profiles: ['gated'],
    fn: async ({ alice }) => {
      const env = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: V2, reason: 'x' });
      assert(env.isError && /NotAllowedError/.test(env.text.join(' ')), `checkout-v2: ${env.text}`);
      assert(await present(V2), 'checkout-v2 must remain');
      assert((await executorAttemptsFor(V2)) === 0, 'executor attempted for checkout-v2');
      return env.text.join(' ');
    },
  },
  {
    id: 'mixed-owner-location-denied-whole',
    ac: ['AC-10'],
    profiles: ['gated'],
    fn: async ({ alice }) => {
      const preview = await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.preview-retirement', { entityRef: LINT });
      const affected = (preview.structuredContent as RetirementPreview).affected.map(a => a.entityRef);
      assert(affected.includes(SANDBOX), `affected set missing sandbox: ${affected}`);
      const env = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: LINT, reason: 'x' });
      assert(env.isError && /payments-ledger-sandbox/.test(env.text.join(' ')), `lint-bot: ${env.text}`);
      assert((await present(LINT)) && (await present(SANDBOX)), 'mixed location entities must remain');
      assert((await executorAttemptsFor(LINT)) === 0, 'executor attempted for mixed location');
      return `affected [${affected.join(', ')}]; ${env.text.join(' ')}`;
    },
  },
  {
    id: 'preview-is-not-a-grant-and-stale-is-rejected',
    ac: ['AC-12'],
    profiles: ['gated'],
    fn: async ({ alice }) => {
      const pv = await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.preview-retirement', { entityRef: P });
      const version = (pv.structuredContent as RetirementPreview).resourceVersion;
      const withVersion = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: P, reason: 'x', expectedVersion: version });
      const stale = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: V2, reason: 'x', expectedVersion: 'a'.repeat(24) });
      const cpv = await mcpCall(alice, MCP_DEFAULT, 'retirement-demo.preview-retirement', { entityRef: C });
      const borrowed = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, {
        entityRef: P,
        reason: 'x',
        expectedVersion: (cpv.structuredContent as RetirementPreview).resourceVersion,
      });
      assert(withVersion.isError && /NotAllowedError/.test(withVersion.text.join(' ')), 'preview version granted access');
      assert(stale.isError && /ConflictError/.test(stale.text.join(' ')), `stale: ${stale.text}`);
      assert(borrowed.isError && /ConflictError/.test(borrowed.text.join(' ')), `borrowed: ${borrowed.text}`);
      assert(await present(P), 'payments-api must remain');
      return `payments with its own preview version -> ${withVersion.text.join(' ').split(':')[0]}; stale -> ConflictError; checkout's version on payments -> ConflictError`;
    },
  },
  // Act 3: separate agent identity under a task grant (gated only)
  {
    id: 'act3-agent-narrower-than-alice',
    ac: ['ACT3'],
    profiles: ['gated'],
    fn: async ({ alice, agent }) => {
      const g = await http('POST', '/api/retirement-demo/grants', alice, {
        agentRef: AGENT, taskId: 'MIG-42', targets: [C], ttlMinutes: 15,
      });
      assert(g.status === 200, `grant ${g.status}`);
      const legacy = await mcpCall(agent, MCP_DEFAULT, RETIRE_TOOL, { entityRef: LEGACY, reason: 'x' });
      assert(legacy.isError && /outside-task-grant/.test(legacy.text.join(' ')), `agent legacy: ${legacy.text}`);
      assert(await present(LEGACY), 'legacy must remain after agent denial');
      assert((await executorAttemptsFor(LEGACY)) === 0, 'executor attempted for agent legacy');
      const cp = await mcpCall(agent, MCP_DEFAULT, RETIRE_TOOL, { entityRef: C, reason: 'x' });
      assert(!cp.isError && (cp.structuredContent as RetirementResult).outcome === 'REMOVED_VERIFIED', `agent cp: ${cp.text}`);
      const mine = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: LEGACY, reason: 'x' });
      assert(!mine.isError && (mine.structuredContent as RetirementResult).outcome === 'REMOVED_VERIFIED', `alice legacy: ${mine.text}`);
      await resetFixtures('e2e-act3');
      return `grant ${g.json.grant.grantId} (delegator ${g.json.grant.delegatorRef}); agent legacy -> outside-task-grant, 0 executor calls; agent checkout-preview -> REMOVED_VERIFIED; Alice legacy -> REMOVED_VERIFIED`;
    },
  },
  {
    id: 'act3-grant-lifecycle-and-binding',
    ac: ['ACT3'],
    profiles: ['gated'],
    fn: async ({ alice, agent }) => {
      const out: string[] = [];
      const issue = (token: string, body: object) => http('POST', '/api/retirement-demo/grants', token, body);
      const base = { agentRef: AGENT, taskId: 'MIG-42', targets: [C], ttlMinutes: 15 };
      const selfIssue = await issue(agent, { ...base, targets: [LEGACY] });
      assert(selfIssue.status === 403, `agent self-issue ${selfIssue.status}`);
      out.push(`agent issues grant -> ${selfIssue.status}`);
      const overDelegate = await issue(alice, { ...base, targets: [P] });
      assert(overDelegate.status === 403, `alice payments grant ${overDelegate.status}`);
      out.push(`alice delegates payments-api -> ${overDelegate.status}`);
      const toHuman = await issue(alice, { ...base, agentRef: 'user:default/bob' });
      assert(toHuman.status === 400, `grant to bob ${toHuman.status}`);
      out.push(`grant to non-agent -> ${toHuman.status}`);
      const extraField = await issue(alice, { ...base, delegatorRef: 'user:default/carol' });
      assert(extraField.status === 400, `client-supplied delegator ${extraField.status}`);
      out.push(`client-supplied delegatorRef -> ${extraField.status}`);

      const attempt = async (label: string, re: RegExp) => {
        const e = await mcpCall(agent, MCP_DEFAULT, RETIRE_TOOL, { entityRef: C, reason: 'x' });
        assert(e.isError && re.test(e.text.join(' ')), `${label}: ${e.text}`);
        out.push(`${label} -> ${e.text.join(' ').match(re)?.[0]}`);
      };
      // Earlier resets leave revoked grants on record, so "no active grant" may
      // be reported as no-task-grant or task-grant-revoked; both deny.
      await attempt('no active grant', /no-task-grant|task-grant-revoked|task-grant-expired/);
      const g1 = (await issue(alice, base)).json.grant;
      await operator('POST', `/operator/grants/${g1.grantId}/expire`, {});
      await attempt('expired grant', /task-grant-expired/);
      const g2 = (await issue(alice, base)).json.grant;
      const agentRevoke = await http('POST', `/api/retirement-demo/grants/${g2.grantId}/revoke`, agent, {});
      assert(agentRevoke.status === 403, `agent revoke ${agentRevoke.status}`);
      await http('POST', `/api/retirement-demo/grants/${g2.grantId}/revoke`, alice, {});
      await attempt('revoked grant', /task-grant-revoked/);
      await operator('POST', '/operator/grants/raw', { agentRef: 'user:default/other-agent', delegatorRef: 'user:default/alice', taskId: 'MIG-42', action: 'retirement-demo:retire-service', targets: [C], ttlMinutes: 10 });
      await attempt('grant only for another agent', /no-task-grant|task-grant-revoked|task-grant-expired/);
      await operator('POST', '/operator/grants/raw', { agentRef: AGENT, delegatorRef: 'user:default/alice', taskId: 'MIG-42', action: 'retirement-demo:other-action', targets: [C], ttlMinutes: 10 });
      await attempt('grant for another action', /grant-is-for-another-action/);
      await issue(alice, { ...base, targets: [LEGACY] });
      await attempt('grant for another target', /outside-task-grant/);
      assert(await present(C), 'checkout-preview must remain');
      assert((await executorAttemptsFor(C)) === 0, 'executor attempted');
      await resetFixtures('e2e-act3');
      return out.join('; ') + '; executor attempts 0';
    },
  },
  {
    id: 'act3-alice-losing-authority-stops-the-agent',
    ac: ['ACT3'],
    profiles: ['gated'],
    fn: async ({ alice, agent }) => {
      const base = { agentRef: AGENT, taskId: 'MIG-42', targets: [C], ttlMinutes: 15 };
      assert((await http('POST', '/api/retirement-demo/grants', alice, base)).status === 200, 'grant');
      await operator('POST', '/operator/principals/suspend', { entityRef: 'user:default/alice', suspended: true });
      const s1 = await mcpCall(agent, MCP_DEFAULT, RETIRE_TOOL, { entityRef: C, reason: 'x' });
      await operator('POST', '/operator/principals/suspend', { entityRef: 'user:default/alice', suspended: false });
      assert(s1.isError && /delegator-suspended/.test(s1.text.join(' ')), `suspended: ${s1.text}`);
      await operator('POST', '/operator/approvals/withdraw', { entityRef: C });
      const s2 = await mcpCall(agent, MCP_DEFAULT, RETIRE_TOOL, { entityRef: C, reason: 'x' });
      const s3 = await mcpCall(alice, MCP_DEFAULT, RETIRE_TOOL, { entityRef: C, reason: 'x' });
      assert(s2.isError && /delegator-not-authorized/.test(s2.text.join(' ')), `withdrawn: ${s2.text}`);
      assert(s3.isError && /retirement-not-approved/.test(s3.text.join(' ')), `alice after withdrawal: ${s3.text}`);
      assert(await present(C), 'checkout-preview must remain');
      assert((await executorAttemptsFor(C)) === 0, 'executor attempted');
      await resetFixtures('e2e-act3');
      return 'Alice suspended -> agent denied (delegator-suspended); approval withdrawn -> agent denied (delegator-not-authorized) and Alice denied too; 0 executor calls';
    },
  },
  {
    id: 'act3-agent-cannot-bypass-the-grant',
    ac: ['ACT3', 'AC-11'],
    profiles: ['gated'],
    fn: async ({ alice, agent }) => {
      await http('POST', '/api/retirement-demo/grants', alice, { agentRef: AGENT, taskId: 'MIG-42', targets: [C], ttlMinutes: 15 });
      const snap = await snapshot();
      const legTarget = path.join(ROOT, 'fixtures/targets/legacy-checkout-worker.yaml');
      const loc = snap.locations.find(l => l.target === legTarget);
      const uid = snap.entities.find(e => e.entityRef === LEGACY)?.uid;
      assert(loc && uid, 'legacy-checkout-worker location/uid not found; reset first');
      const r = {
        catalogDeleteLocation: await http('DELETE', `/api/catalog/locations/${loc.id}`, agent),
        catalogDeleteEntity: await http('DELETE', `/api/catalog/entities/by-uid/${uid}`, agent),
        actionsRoute: await http('POST', '/api/retirement-demo/.backstage/actions/v1/actions/retirement-demo:retire-service/invoke', agent, { entityRef: LEGACY, reason: 'x' }),
        uiRoute: await http('POST', '/api/retirement-demo/ui/retire', agent, { entityRef: LEGACY, reason: 'x' }),
        operatorReset: await http('POST', '/api/retirement-demo/operator/reset', agent, {}),
        operatorRawGrant: await http('POST', '/api/retirement-demo/operator/grants/raw', agent, {}),
      };
      for (const [k, v] of Object.entries(r)) {
        assert(v.status === 403 || v.status === 404, `${k} returned ${v.status}`);
      }
      const named = await mcpCall(agent, MCP_NAMED, RETIRE_TOOL, { entityRef: LEGACY, reason: 'x' });
      const nativeTool = await mcpCall(agent, MCP_DEFAULT, 'catalog.unregister-entity', { type: { locationId: loc.id } });
      assert(named.isError && /outside-task-grant/.test(named.text.join(' ')), `named: ${named.text}`);
      assert(nativeTool.isError && /NotFoundError/.test(nativeTool.text.join(' ')), `native tool: ${nativeTool.text}`);
      assert(await present(LEGACY), 'legacy must remain');
      assert((await executorAttemptsFor(LEGACY)) === 0, 'executor attempted');
      await resetFixtures('e2e-act3');
      return Object.entries(r).map(([k, v]) => `${k} -> ${v.status}`).join('; ') + '; named MCP -> outside-task-grant; catalog.unregister-entity -> NotFound';
    },
  },
  // Full deterministic replay (AC-05/06/14/15), then evidence checks.
  {
    id: 'deterministic-replay',
    ac: ['AC-04', 'AC-05', 'AC-06', 'AC-14', 'AC-15'],
    fn: async ({ mode }) => {
      await operator('POST', '/operator/reset', { label: `e2e-pre-replay-${mode}` });
      const a = await runReplay({ instance: 'alice', direct: false, endpointPath: MCP_DEFAULT, label: `e2e-replay:${mode}` });
      assert(a.verdict === 'PASS', `replay verdict ${a.verdict}: ${JSON.stringify(a.checks)}`);
      assert(a.kind === 'deterministic-mcp-replay', 'replay label');
      return a.checks
        .map(c => `${c.entityRef}: ${c.observed.outcome}, present=${c.observed.present}, executorAttempts=${c.observed.executorAttempts}`)
        .join('; ');
    },
  },
  {
    id: 'evidence-has-caller-and-executor-without-secrets',
    ac: ['AC-16'],
    fn: async ({ alice, bob, operatorToken }) => {
      const runs: RunRecord[] = (await http('GET', '/api/retirement-demo/runs', alice)).json.runs;
      const last = runs.find(r => r.status === 'completed');
      assert(last, 'no completed run');
      const exp = await exportRun(last.runId);
      const attempted = exp.events.find(e => e.phase === 'executor-attempted');
      assert(attempted, 'no executor attempt in the last completed run');
      assert(attempted.caller.subject === 'user:default/alice', 'caller missing');
      assert(attempted.executorSubject === 'demo-retirement-executor', 'executor missing');
      const blob = JSON.stringify(exp);
      const env = loadEnv();
      for (const [name, secret] of Object.entries({ alice, bob, operatorToken, ...env })) {
        if (secret && secret.length > 12) assert(!blob.includes(secret), `export contains ${name}`);
      }
      assert(!/Bearer\s+\S/.test(blob), 'export contains a bearer value');
      const replayFile = fs.readdirSync(EVIDENCE_DIR).filter(f => f.startsWith(last.runId));
      for (const f of replayFile) {
        const text = fs.readFileSync(path.join(EVIDENCE_DIR, f), 'utf8');
        assert(!text.includes(alice), `${f} contains alice's token`);
      }
      return `run ${last.runId}: caller ${attempted.caller.subject}, executor ${attempted.executorSubject}; no tokens/secrets in export or replay files`;
    },
  },
  {
    id: 'removals-are-not-resurrected',
    ac: ['AC-17'],
    fn: async ({ mode }) => {
      const removed = mode === 'gated' ? [C] : [C, P];
      const waitMs = 45_000;
      await new Promise(r => setTimeout(r, waitMs));
      for (const ref of removed) assert(!(await present(ref)), `${ref} reappeared`);
      return `${removed.join(', ')} still absent after ${waitMs / 1000} s (orphan cleanup cadence is 30 s)`;
    },
  },
  {
    id: 'reset-restores-targets-only',
    ac: ['AC-13'],
    fn: async ({ alice }) => {
      const before: string[] = (await http('GET', '/api/retirement-demo/runs', alice)).json.runs.map(
        (r: RunRecord) => r.runId,
      );
      const t0 = Date.now();
      const reset = await resetFixtures(`e2e-post-${Date.now()}`);
      const ms = Date.now() - t0;
      const after = (await http('GET', '/api/retirement-demo/runs', alice)).json;
      const status = await http('GET', '/api/retirement-demo/status', alice);
      const snap = await snapshot();
      assert(snap.entities.every(e => e.present), 'not all targets restored');
      assert(status.status === 200 && status.json.caller.userEntityRef === 'user:default/alice', 'auth not preserved');
      // /runs returns the newest 50; the new run shifts that window by one, so
      // compare the overlap and prove the oldest earlier run is still exportable.
      const overlap = before.slice(0, 40);
      assert(overlap.every(id => after.runs.some((r: RunRecord) => r.runId === id)), 'evidence lost');
      const oldest = before[before.length - 1];
      const exported = await exportRun(oldest);
      assert(exported.run.runId === oldest, 'oldest earlier run no longer exportable');
      assert(ms < 30_000, `reset took ${ms} ms`);
      return `reset ${ms} ms (registered [${reset.registered.join(', ')}]); alice's existing token still valid; earlier runs retained (checked newest 40 and oldest listed run ${oldest})`;
    },
  },
  {
    id: 'unsafe-mode-requires-explicit-opt-in',
    ac: ['AC-18'],
    fn: async () => {
      const probe = async (overlay: Record<string, unknown>, env: NodeJS.ProcessEnv) => {
        const file = path.join(STATE_DIR, `probe-${Date.now()}.yaml`);
        fs.writeFileSync(
          file,
          JSON.stringify({
            backend: {
              baseUrl: 'http://localhost:7099',
              listen: { port: 7099, host: '127.0.0.1' },
              database: { client: 'better-sqlite3', connection: ':memory:' },
            },
            ...overlay,
          }),
        );
        const child = spawn(
          'yarn',
          ['workspace', 'backend', 'start', '--config', path.join(ROOT, 'app-config.yaml'), '--config', file],
          { cwd: ROOT, env: { ...process.env, ...loadEnv(), ...env, DEMO_LAB_ENABLED: env.DEMO_LAB_ENABLED ?? '' }, detached: true },
        );
        let out = '';
        child.stdout.on('data', d => (out += d));
        child.stderr.on('data', d => (out += d));
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !/Refusing to start|Plugin initialization complete/.test(out)) {
          await new Promise(r => setTimeout(r, 500));
        }
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // gone
        }
        fs.rmSync(file, { force: true });
        out = out.replace(/\x1b\[[0-9;]*m/g, '');
        return out.match(/Refusing to start[^\n"]*/)?.[0] ?? (/Plugin initialization complete/.test(out) ? 'STARTED' : 'TIMEOUT');
      };
      const noOptIn = await probe({ retirementDemo: { mode: 'ungated-lab' } }, {});
      const unknown = await probe({ retirementDemo: { mode: 'unsafe' } }, { DEMO_LAB_ENABLED: 'true' });
      assert(/Refusing to start/.test(noOptIn), `lab without opt-in: ${noOptIn}`);
      assert(/Refusing to start/.test(unknown), `unknown mode: ${unknown}`);
      return `ungated-lab without DEMO_LAB_ENABLED: "${noOptIn}"; unknown mode: "${unknown}"`;
    },
  },
];

async function main() {
  const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const health = await getHealth();
  const mode = health.mode as Mode;
  const ctx: Ctx = {
    mode,
    alice: await printToken('alice'),
    bob: await printToken('bob'),
    agent: await printToken('mig42-agent'),
    operatorToken: requireEnv('DEMO_OPERATOR_TOKEN'),
  };
  captureProbe('alice', ctx.alice);
  log(`Live acceptance suite — profile ${mode} — ${BACKEND_URL}`);
  await operator('POST', '/operator/reset', { label: `e2e-${mode}` });

  const results: Result[] = [];
  for (const t of tests) {
    if (only.length && !only.includes(t.id)) continue;
    if (t.profiles && !t.profiles.includes(mode)) {
      results.push({ id: t.id, ac: t.ac, status: 'SKIP', detail: `not applicable to ${mode}` });
      continue;
    }
    try {
      const detail = await t.fn(ctx);
      results.push({ id: t.id, ac: t.ac, status: 'PASS', detail });
      log(`PASS ${t.id} [${t.ac.join(',')}] ${detail}`);
    } catch (e) {
      if (e instanceof Skip) {
        results.push({ id: t.id, ac: t.ac, status: 'SKIP', detail: e.message });
        log(`SKIP ${t.id} [${t.ac.join(',')}] ${e.message}`);
        continue;
      }
      results.push({ id: t.id, ac: t.ac, status: 'FAIL', detail: (e as Error).message });
      log(`FAIL ${t.id} [${t.ac.join(',')}] ${(e as Error).message}`);
    }
  }
  await operator('POST', '/operator/reset', { label: `after-e2e-${mode}` });
  const file = path.join(EVIDENCE_DIR, `e2e-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJson(file, { profile: mode, ranAt: new Date().toISOString(), results });
  const failed = results.filter(r => r.status === 'FAIL').length;
  log(`\n${results.filter(r => r.status === 'PASS').length} passed, ${failed} failed, ${results.filter(r => r.status === 'SKIP').length} skipped -> ${path.relative(process.cwd(), file)}`);
  if (failed) process.exitCode = 1;
}

main().catch(e => {
  log(String(e.stack ?? e));
  process.exit(1);
});
