import { BACKEND_URL, requireEnv } from './env';
import type { CatalogSnapshot, OperatorHealth, ResetResult, RunExport, RunRecord } from './types';

/**
 * Calls the retirement-demo operator routes with the static external-access
 * token. That token is restricted (app-config.yaml) to the retirement-demo
 * plugin, so it cannot reach the catalog or MCP endpoints.
 */
export async function operator<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const send = () =>
    fetch(`${BACKEND_URL}/api/retirement-demo${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${requireEnv('DEMO_OPERATOR_TOKEN')}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // After a profile restart, pooled keep-alive sockets to the previous backend
  // process are dead; retry connection-level failures a few times.
  let res: Response | undefined;
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await send();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${json?.error?.message ?? text.slice(0, 300)}`,
    );
  }
  return json as T;
}

export const getHealth = () => operator<OperatorHealth>('GET', '/operator/health');
export const getSnapshot = () => operator<CatalogSnapshot>('GET', '/operator/snapshot');
export const exportRun = (runId: string) =>
  operator<RunExport>('GET', `/operator/runs/${encodeURIComponent(runId)}/export`);
/** `--mode gated|ungated-lab`: on the lab server a run may choose whether the check runs. */
export function requestedMode(): 'gated' | 'ungated-lab' | undefined {
  const i = process.argv.indexOf('--mode');
  const m = i >= 0 ? process.argv[i + 1] : undefined;
  if (m === undefined) return undefined;
  if (m !== 'gated' && m !== 'ungated-lab') throw new Error(`--mode must be gated or ungated-lab, got ${m}`);
  return m;
}
export const startRun = (label?: string, mode = requestedMode()) =>
  operator<{ activeRun: RunRecord }>('POST', '/operator/runs', { label, ...(mode ? { mode } : {}) });
export const resetFixtures = (label?: string, mode = requestedMode()) =>
  operator<ResetResult>('POST', '/operator/reset', { label, ...(mode ? { mode } : {}) });
export const presentIn = (snap: CatalogSnapshot, entityRef: string) =>
  snap.entities.find(e => e.entityRef === entityRef)?.present ?? false;
