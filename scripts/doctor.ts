/**
 * Prerequisite and health check. Prints no secret values.
 *
 *   yarn demo:doctor
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_URL, ROOT, loadEnv, log } from './lib/env';
import { getHealth } from './lib/operator';
import { printToken, unverifiedClaims } from './lib/cliAuth';

type Check = { name: string; ok: boolean | 'warn'; detail: string };
const checks: Check[] = [];
const add = (name: string, ok: Check['ok'], detail: string) => checks.push({ name, ok, detail });

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return `ERROR ${(e as Error).message.split('\n')[0]}`;
  }
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major === 22 || major === 24, `v${process.versions.node} (scaffold supports 22 || 24)`);
  add('yarn', sh('yarn', ['--version']).startsWith('4.'), sh('yarn', ['--version']));
  const bs = JSON.parse(fs.readFileSync(path.join(ROOT, 'backstage.json'), 'utf8')).version;
  add('backstage release', true, bs);

  let env: Record<string, string> = {};
  try {
    env = loadEnv();
    const required = ['POSTGRES_PASSWORD', 'AUTH_SESSION_SECRET', 'DEX_BACKSTAGE_CLIENT_SECRET', 'DEMO_OPERATOR_TOKEN', 'DEMO_EXECUTOR_TOKEN', 'DEMO_PROBE_SERVICE_TOKEN', 'DEMO_MIG42_AGENT_PASSWORD', 'DEMO_ALICE_PASSWORD', 'DEMO_ALICE_PASSWORD_HASH'];
    const missing = required.filter(k => !env[k]);
    add('.env', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${Object.keys(env).length} keys present (values not shown)`);
    add('live model key', env.NEBIUS_API_KEY ? true : 'warn', env.NEBIUS_API_KEY ? 'NEBIUS_API_KEY present (yarn demo:live)' : 'not set; live model run unavailable');
    add('.env lab flag', !('DEMO_LAB_ENABLED' in env), 'DEMO_LAB_ENABLED must not be set in .env');
  } catch (e) {
    add('.env', false, (e as Error).message);
  }

  const ps = sh('docker', ['compose', '--env-file', '.env', 'ps', '--format', '{{.Service}} {{.Status}} {{.Ports}}']);
  for (const svc of ['postgres', 'dex']) {
    const line = ps.split('\n').find(l => l.startsWith(svc)) ?? '';
    add(`docker ${svc}`, /Up/.test(line) && /127\.0\.0\.1:/.test(line) && !/0\.0\.0\.0:/.test(line), line || 'not running');
  }

  const listen = sh('ss', ['-ltnH']);
  for (const port of ['7007', '5432', '5556']) {
    const lines = listen.split('\n').filter(l => new RegExp(`:${port}\\s`).test(l));
    const exposed = lines.some(l => /(0\.0\.0\.0|\*|\[::\]):/.test(l.split(/\s+/)[3] ?? ''));
    add(`port ${port}`, lines.length > 0 && !exposed, lines.length ? (exposed ? 'LISTENING ON A PUBLIC INTERFACE' : 'loopback only') : 'not listening');
  }

  add('frontend build', fs.existsSync(path.join(ROOT, 'packages/app/dist/index.html')) ? true : 'warn', 'packages/app/dist (yarn demo:build)');

  try {
    const ready = await fetch(`${BACKEND_URL}/.backstage/health/v1/readiness`);
    add('server ready', ready.ok, `${BACKEND_URL} readiness ${ready.status}`);
    const h = await getHealth();
    add('profile', true, `${h.mode}${h.mode === 'ungated-lab' ? ' (INTENTIONALLY UNSAFE LAB)' : ''}; active run ${h.activeRun?.runId ?? 'none'}`);
    add('org seeded', h.orgSeeded, 'user:default/alice present');
    add('catalog seeded', h.catalogSeeded ? true : 'warn', h.snapshot.entities.map(e => `${e.entityRef.split('/')[1]}=${e.present ? 'present' : 'absent'}`).join(', '));
    add('permissions active', h.permissionsEnabled, 'permission.enabled with demo policy module');
    add('OAuth (CIMD) configured', h.oauthCimdEnabled, 'auth.clientIdMetadataDocuments.enabled');
    add('MCP action sources', JSON.stringify(h.mcp.exposedPluginSources) === '["retirement-demo"]', `${h.mcp.exposedPluginSources.join(', ')}; endpoints ${h.mcp.defaultEndpoint}, ${h.mcp.namedEndpoints.join(', ')}`);
    const anon = await fetch(`${BACKEND_URL}/api/mcp-actions/v1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
    add('MCP requires auth', anon.status === 401, `anonymous POST -> ${anon.status}`);
    const prm = await fetch(`${BACKEND_URL}/.well-known/oauth-protected-resource/api/mcp-actions/v1`);
    add('MCP protected-resource metadata', prm.ok, `${prm.status} ${prm.ok ? JSON.stringify((await prm.json()).authorization_servers) : ''}`);
  } catch (e) {
    add('server', false, `${(e as Error).message} (yarn demo:start:gated)`);
  }

  for (const user of ['alice', 'bob', 'mig42-agent']) {
    try {
      const claims = unverifiedClaims(await printToken(user));
      add(`CLI login ${user}`, true, `${claims.sub}, expires ${new Date(Number(claims.exp) * 1000).toISOString()}`);
    } catch {
      add(`CLI login ${user}`, 'warn', `not logged in (yarn demo:login ${user})`);
    }
  }

  for (const c of checks) {
    log(`${c.ok === true ? ' OK ' : c.ok === 'warn' ? 'WARN' : 'FAIL'}  ${c.name.padEnd(32)} ${c.detail}`);
  }
  if (checks.some(c => c.ok === false)) process.exitCode = 1;
}

main();
