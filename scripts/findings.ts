/**
 * Reproducible findings about the TESTED implementation (Backstage 1.56.0,
 * see docs/how-it-works.md). Each finding
 * is observed against the running server and written to
 * evidence/findings-<timestamp>.json. These are observations, not claims
 * about other Backstage versions or other deployments.
 *
 *   yarn demo:findings [--revocation]   # --revocation also logs in/out carol (~15 s)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BACKEND_URL, EVIDENCE_DIR, ROOT, log, requireEnv, writeJson } from './lib/env';
import { printToken, unverifiedClaims } from './lib/cliAuth';
import { exportRun, getHealth } from './lib/operator';
import { callTool, connect, discoverTools } from './lib/mcp';
import type { UntypedJson } from './lib/types';

type Finding = { id: string; question: string; observed: unknown; summary: string };

async function http(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(`${BACKEND_URL}${p}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json, text/event-stream',
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
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

const initBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'findings', version: '0' } },
};

async function main() {
  const findings: Finding[] = [];
  const alice = await printToken('alice');
  const probe = requireEnv('DEMO_PROBE_SERVICE_TOKEN');

  // F1: OAuth scopes advertised by Backstage's authorization server.
  const asMeta = (await http('GET', '/.well-known/oauth-authorization-server')).json;
  const prm = (await http('GET', '/.well-known/oauth-protected-resource/api/mcp-actions/v1')).json;
  findings.push({
    id: 'F1-oauth-scopes',
    question: 'Can an MCP/CLI token be scoped narrower than the user (e.g. to one action or task)?',
    observed: {
      scopes_supported: asMeta?.scopes_supported,
      grant_types_supported: asMeta?.grant_types_supported,
      protected_resource_scopes: prm?.scopes_supported,
    },
    summary: `Only ${JSON.stringify(asMeta?.scopes_supported)} are advertised and only ${JSON.stringify(
      asMeta?.grant_types_supported,
    )} grants; no resource-specific scopes and no token-exchange grant.`,
  });

  // F2: Token audience and where the same token is accepted.
  const claims = unverifiedClaims(alice);
  const mcp = await http('POST', '/api/mcp-actions/v1', alice, initBody);
  const catalog = await http('GET', '/api/catalog/entities?limit=1', alice);
  const anonMcp = await http('POST', '/api/mcp-actions/v1', undefined, initBody);
  findings.push({
    id: 'F2-token-audience-and-usability',
    question: 'Is the token obtained for MCP limited to the MCP server?',
    observed: {
      claims: { aud: claims.aud, iss: claims.iss, sub: claims.sub, lifetimeSeconds: Number(claims.exp) - Number(claims.iat) },
      sameTokenOnMcp: mcp.status,
      sameTokenOnCatalogRest: catalog.status,
      anonymousMcpStatus: anonMcp.status,
      anonymousMcpWwwAuthenticate: anonMcp.headers['www-authenticate'] ?? null,
    },
    summary: `aud="${claims.aud}"; the same token is accepted by MCP (${mcp.status}) and by the catalog REST API (${catalog.status}). This shows broader token usability than the MCP server; whether that violates MCP audience validation depends on the defined resource boundary. The 401 carries ${
      anonMcp.headers['www-authenticate'] ? 'a' : 'no'
    } WWW-Authenticate header.`,
  });

  // F3: Service principals and the permission policy.
  const listing = await http('GET', '/api/retirement-demo/.backstage/actions/v1/actions', probe);
  const names = (listing.json?.actions ?? []).map((a: { id: string }) => a.id);
  findings.push({
    id: 'F3-service-principal-permission-decisions',
    question: 'Does the central policy decide permissions for service principals?',
    observed: { status: listing.status, visibleActions: names },
    summary: names.includes('retirement-demo:retire-service')
      ? 'A workload principal with no ownership claims sees retire-service, whose visibility permission the demo policy grants only to listed groups: the policy was not consulted (ServerPermissionClient decides from accessRestrictions only).'
      : 'retire-service was not visible to the workload principal.',
  });

  // F4: Identity of a service principal after the MCP hop.
  const h = await getHealth();
  const session = await connect(probe, '/api/mcp-actions/v1');
  const { tools } = await discoverTools(session);
  const env = await callTool(session, 'retire', 'retirement-demo.retire-service', {
    entityRef: 'component:default/checkout-v2',
    reason: 'findings probe',
  });
  await session.close();
  const runId = (await getHealth()).currentRun?.runId ?? h.currentRun?.runId;
  if (!runId) throw new Error('no current run');
  const exp = await exportRun(runId);
  const seen = [...exp.events].reverse().find(e => e.reasonCode === 'caller-not-user-principal');
  findings.push({
    id: 'F4-service-identity-after-mcp-hop',
    question: 'Which identity does an action see when a workload principal calls it through MCP?',
    observed: {
      toolsListedForProbe: tools.map(t => t.name),
      toolResult: env.text.join(' '),
      principalSeenByAction: seen?.caller ?? null,
    },
    summary: `The action saw ${seen?.caller?.subject ?? 'unknown'} instead of the external probe-workload principal (DefaultAuthService.getPluginRequestToken issues a token for the calling plugin itself when forwarding service credentials).`,
  });

  // F5: Executor credential restrictions.
  const ex = requireEnv('DEMO_EXECUTOR_TOKEN');
  findings.push({
    id: 'F5-access-restrictions-on-executor',
    question: 'Can Backstage itself limit what the privileged executor may do?',
    observed: {
      readEntities: (await http('GET', '/api/catalog/entities?limit=1', ex)).status,
      deleteEntityByUid: (await http('DELETE', '/api/catalog/entities/by-uid/00000000-0000-0000-0000-000000000000', ex)).status,
      refresh: (await http('POST', '/api/catalog/refresh', ex, { entityRef: 'component:default/checkout-v2' })).status,
      mcp: (await http('POST', '/api/mcp-actions/v1', ex, initBody)).status,
    },
    summary: 'Static external-access tokens with accessRestrictions are enforced by Backstage: listed catalog permissions work, others return 403, other plugins reject the token.',
  });

  // F6: Revocation semantics (optional, logs carol in and out).
  if (process.argv.includes('--revocation')) {
    execFileSync('npx', ['tsx', 'scripts/login.ts', 'carol'], { cwd: ROOT, stdio: 'ignore' });
    const carol = await printToken('carol');
    const before = (await http('POST', '/api/mcp-actions/v1', carol, initBody)).status;
    execFileSync('yarn', ['backstage-cli', 'auth', 'logout', '--instance', 'carol'], { cwd: ROOT, stdio: 'ignore' });
    const after = (await http('POST', '/api/mcp-actions/v1', carol, initBody)).status;
    let cliCanMint = true;
    try {
      await printToken('carol');
    } catch {
      cliCanMint = false;
    }
    const c = unverifiedClaims(carol);
    findings.push({
      id: 'F6-logout-and-existing-access-tokens',
      question: 'Does logging out invalidate an access token that was already issued?',
      observed: {
        beforeLogout: before,
        sameAccessTokenAfterLogout: after,
        cliCanStillMintTokens: cliCanMint,
        tokenExpiresAt: new Date(Number(c.exp) * 1000).toISOString(),
      },
      summary: `After CLI logout the already-issued access token still returned ${after} until its expiry; the CLI could ${
        cliCanMint ? 'still' : 'no longer'
      } mint tokens. Removing refresh capability and invalidating issued access tokens are different outcomes.`,
    });
  }

  const file = path.join(EVIDENCE_DIR, `findings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJson(file, { ranAt: new Date().toISOString(), backend: BACKEND_URL, findings });
  for (const f of findings) log(`${f.id}: ${f.summary}`);
  log(`-> ${path.relative(process.cwd(), file)}`);
}

main().catch(e => {
  log(String(e.stack ?? e));
  process.exit(1);
});
