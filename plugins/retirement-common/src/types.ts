import type { DemoMode } from './constants';

export type EventPhase =
  | 'grant-issued'
  | 'grant-revoked'
  | 'authenticated'
  | 'resolved'
  | 'authorized'
  | 'denied'
  | 'authorization-skipped'
  | 'executor-attempted'
  | 'executor-succeeded'
  | 'verification-succeeded'
  | 'failed';

/**
 * `type` is the Backstage principal type from the validated credential.
 * `kind` is the demo's trusted classification of that principal (from the
 * catalog), so a demo service account for an agent is never mistaken for a human.
 */
export type CallerRef = {
  type: 'user' | 'service';
  subject: string;
  kind?: 'human' | 'agent';
};

/** Delegation facts attached to an agent's operation (server-derived, never client input). */
export type DelegationContext = {
  agentRef: string;
  delegatorRef: string;
  grantId: string;
  taskId: string;
  targets: string[];
  expiresAt: string;
};

/**
 * Custom application logic (not native Backstage task scoping and not RFC 8693):
 * a human delegator lets one authenticated agent account perform one action on
 * an explicit list of targets for one task, until expiry or revocation.
 */
export type TaskGrant = {
  grantId: string;
  agentRef: string;
  delegatorRef: string;
  taskId: string;
  action: string;
  targets: string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokedBy?: string;
  status: 'active' | 'expired' | 'revoked';
};

/** One audit record. Caller fields come from verified credentials only. */
export type DemoEvent = {
  eventId: string;
  runId: string;
  operationId: string;
  timestamp: string;
  mode: DemoMode;
  phase: EventPhase;
  caller: CallerRef;
  executorSubject?: string;
  actionId: string;
  requestedEntityRef?: string;
  affectedEntityRefs?: string[];
  resourceVersion?: string;
  permissionName?: string;
  decision?: 'ALLOW' | 'DENY' | 'SKIPPED';
  reasonCode?: string;
  mutationOccurred?: boolean;
  correlationId: string;
  /** Present when an agent account acts under a task grant. */
  delegation?: DelegationContext;
  /** Free-form, sanitized detail for the presenter (never secrets). */
  detail?: string;
};

/**
 * Authentication failures never resolved a caller, so they are recorded in a
 * separate shape instead of inventing a principal.
 */
export type AuthFailureEvent = {
  eventId: string;
  runId: string;
  timestamp: string;
  mode: DemoMode;
  route: string;
  reasonCode: string;
};

export type RetirementOutcome =
  | 'DENIED'
  | 'FAILED'
  | 'REMOVED_VERIFIED'
  | 'ALREADY_ABSENT'
  | 'UNVERIFIED';

/** Backend-authoritative classification of one catalog entity. */
export type TrustedClassification = {
  entityRef: string;
  kind: string;
  uid: string;
  owner?: string;
  lifecycle?: string;
  environment?: string;
  retirementApproved: boolean;
  approvalId?: string;
  /** Hash over the authoritative fields used for a decision. */
  version: string;
};

export type ServiceSummary = TrustedClassification & {
  title?: string;
  present: boolean;
  locationTarget?: string;
};

export type CallerAssessment = {
  /**
   * Informative only: preview never grants permission. Mode-neutral on
   * purpose, so tool output is identical in both profiles.
   */
  allowedByTrustedRule: boolean;
  reasons: string[];
};

export type RetirementPreview = {
  requestedEntityRef: string;
  present: boolean;
  location?: { id: string; target: string };
  affected: TrustedClassification[];
  affectedSetComplete: boolean;
  resourceVersion?: string;
  impact: string;
  callerAssessment: CallerAssessment;
};

export type RetirementResult = {
  operationId: string;
  correlationId: string;
  requestedEntityRef: string;
  affectedEntityRefs: string[];
  outcome: RetirementOutcome;
  mode: DemoMode;
  resourceAuthorization: 'enforced' | 'skipped-intentionally';
  executorAttempted: boolean;
  reasonCodes: string[];
  delegation?: DelegationContext;
};

export type RunStatus = 'active' | 'completed' | 'abandoned';

export type RunRecord = {
  runId: string;
  mode: DemoMode;
  label?: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  callerSubject?: string;
};

export type CatalogSnapshot = {
  takenAt: string;
  entities: Array<{ entityRef: string; present: boolean; uid?: string }>;
  locations: Array<{ id: string; target: string }>;
};

export type DemoStatus = {
  mode: DemoMode;
  labBanner: boolean;
  activeRun?: RunRecord;
  /** Most recent run (active or completed), followed by the presenter page. */
  currentRun?: RunRecord;
  /**
   * MCP client facts recorded by the replay / live-model runner for the
   * current run. Absent while a run is still active (the MCP plugin does not
   * pass client details to actions).
   */
  currentRunClient?: {
    kind?: string;
    name?: string;
    protocolVersion?: string;
    model?: string;
  };
  caller: { userEntityRef: string; ownershipEntityRefs: string[]; kind?: 'human' | 'agent' };
  executorSubject: string;
  mcp: {
    defaultEndpoint: string;
    namedEndpoints: string[];
    exposedPluginSources: string[];
  };
};
