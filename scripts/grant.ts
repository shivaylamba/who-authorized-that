/**
 * Alice issues (or revokes) the MIG-42 task grant for the agent account,
 * authenticated with HER OWN Backstage token. Same route as the presenter
 * page button. Custom application logic, not native Backstage task scoping.
 *
 *   yarn demo:grant                       # checkout-preview, 15 minutes
 *   yarn demo:grant --targets component:default/checkout-preview,component:default/legacy-checkout-worker
 *   yarn demo:grant --revoke <grantId>
 *   yarn demo:grant --check                # exit 0 if an active MIG-42 grant exists
 */
import { BACKEND_URL, log } from './lib/env';
import { printToken } from './lib/cliAuth';

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const alice = await printToken('alice');
  if (process.argv.includes('--check')) {
    // Exit 0 if mig42-agent holds an active grant covering checkout-preview.
    const res = await fetch(`${BACKEND_URL}/api/retirement-demo/grants`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    const { grants } = (await res.json()) as {
      grants: Array<{ grantId: string; agentRef: string; status: string; targets: string[]; expiresAt: string }>;
    };
    const g = grants.find(
      x =>
        x.status === 'active' &&
        x.agentRef === 'user:default/mig42-agent' &&
        x.targets.includes('component:default/checkout-preview'),
    );
    log(g ? `Active grant ${g.grantId} until ${g.expiresAt}` : 'No active grant for mig42-agent.');
    process.exit(g ? 0 : 1);
  }
  const revoke = arg('--revoke');
  const path = revoke ? `/grants/${encodeURIComponent(revoke)}/revoke` : '/grants';
  const body = revoke
    ? {}
    : {
        agentRef: 'user:default/mig42-agent',
        taskId: 'MIG-42',
        targets: arg('--targets', 'component:default/checkout-preview')!.split(','),
        ttlMinutes: Number(arg('--ttl', '15')),
      };
  const res = await fetch(`${BACKEND_URL}/api/retirement-demo${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status}: ${json?.error?.message}`);
  const g = json.grant;
  log(`${g.grantId} ${g.status}: ${g.delegatorRef} -> ${g.agentRef}, ${g.taskId}, ${g.action}, [${g.targets.join(', ')}], expires ${g.expiresAt}`);
}

main().catch(e => {
  log(String(e.message ?? e));
  process.exit(1);
});
