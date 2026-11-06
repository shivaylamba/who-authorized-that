import type {
  AuthFailureEvent,
  CatalogSnapshot,
  DemoEvent,
  DemoMode,
  RetirementResult,
  RunRecord,
} from '@internal/plugin-retirement-common';

export type { CatalogSnapshot, DemoEvent, RunRecord };

/** Response of GET /api/retirement-demo/operator/health. */
export type OperatorHealth = {
  serverReady: boolean;
  mode: DemoMode;
  activeRun?: RunRecord;
  currentRun?: RunRecord;
  orgSeeded: boolean;
  catalogSeeded: boolean;
  snapshot: CatalogSnapshot;
  permissionsEnabled: boolean;
  oauthCimdEnabled: boolean;
  mcp: { defaultEndpoint: string; namedEndpoints: string[]; exposedPluginSources: string[] };
  executorSubject: string;
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

/** Response of GET /api/retirement-demo/operator/runs/:runId/export. */
export type RunExport = {
  exportedAt: string;
  run: RunRecord;
  executorSubject: string;
  events: Array<DemoEvent & { seq: number }>;
  authFailures: AuthFailureEvent[];
  operations: StoredOperation[];
  artifacts: unknown;
};

export type ResetResult = {
  registered: string[];
  alreadyPresent: string[];
  missingAfterWait: string[];
  durationMs?: number;
  activeRun: RunRecord;
};

/**
 * Raw HTTP probes in the acceptance and findings scripts deliberately inspect
 * arbitrary response bodies (error envelopes, third-party JSON). This single,
 * explicit alias marks that boundary instead of scattering `any` annotations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UntypedJson = any;

/** Executor attempts recorded for operations on `entityRef` (optionally by one caller). */
export function executorAttempts(exp: RunExport, entityRef: string, callerSubject?: string): number {
  const ops = new Set(
    exp.events
      .filter(
        e =>
          e.requestedEntityRef === entityRef &&
          (callerSubject === undefined || e.caller.subject === callerSubject),
      )
      .map(e => e.operationId),
  );
  return exp.events.filter(e => ops.has(e.operationId) && e.phase === 'executor-attempted').length;
}
