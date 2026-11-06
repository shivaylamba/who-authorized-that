import crypto from 'node:crypto';
import {
  Entity,
  RELATION_OWNED_BY,
  stringifyEntityRef,
} from '@backstage/catalog-model';
import {
  ANNOTATION_ENVIRONMENT,
  TrustedClassification,
} from '@internal/plugin-retirement-common';

export type ApprovalRecord = {
  entityRef: string;
  approvalId: string;
  approvedBy: string;
};

function hash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Builds the backend-authoritative classification for one entity.
 *
 * Ownership comes from the catalog's stitched `ownedBy` relations, environment
 * from an operator-owned fixture annotation, lifecycle from the entity spec and
 * approval from the backend-owned approvals table. Nothing here is taken from
 * tool input or issue text.
 */
export function classifyEntity(
  entity: Entity,
  approval: ApprovalRecord | undefined,
): TrustedClassification {
  const entityRef = stringifyEntityRef(entity).toLocaleLowerCase('en-US');
  const owners = (entity.relations ?? [])
    .filter(r => r.type === RELATION_OWNED_BY)
    .map(r => r.targetRef.toLocaleLowerCase('en-US'));
  // Exactly one owner, or the owner is unknown (which denies).
  const owner = owners.length === 1 ? owners[0] : undefined;
  const lifecycle =
    typeof entity.spec?.lifecycle === 'string' ? entity.spec.lifecycle : undefined;
  const environment = entity.metadata.annotations?.[ANNOTATION_ENVIRONMENT];
  const uid = entity.metadata.uid ?? '';

  const authoritative = {
    entityRef,
    kind: entity.kind,
    uid,
    owner,
    lifecycle,
    environment,
    retirementApproved: Boolean(approval),
    approvalId: approval?.approvalId,
  };
  return { ...authoritative, version: hash(authoritative) };
}

/** Version over the whole affected set and the location that would be removed. */
export function affectedSetVersion(
  location: { id: string; target: string },
  affected: TrustedClassification[],
): string {
  return hash({
    location,
    affected: affected
      .map(a => [a.entityRef, a.version])
      .sort((a, b) => a[0].localeCompare(b[0])),
  });
}

/** Resource refs passed to the permission framework bind ref and version. */
export function toResourceRef(c: { entityRef: string; version: string }) {
  return `${c.entityRef}@${c.version}`;
}

export function parseResourceRef(
  resourceRef: string,
): { entityRef: string; version: string } | undefined {
  const at = resourceRef.lastIndexOf('@');
  if (at <= 0) return undefined;
  const entityRef = resourceRef.slice(0, at);
  const version = resourceRef.slice(at + 1);
  if (!/^[a-f0-9]{24}$/.test(version)) return undefined;
  return { entityRef, version };
}

/**
 * Human-readable reasons a classification fails the gated rule. These are
 * explanatory output for the synthetic lab; the authoritative decision always
 * comes from the permission framework.
 */
export function explainGatedRule(
  c: TrustedClassification,
  ownershipClaims: string[],
): string[] {
  const reasons: string[] = [];
  if (!c.owner) reasons.push('owner-unknown');
  else if (!ownershipClaims.includes(c.owner)) reasons.push('not-owned-by-caller');
  if (c.environment !== 'development') reasons.push('not-development-environment');
  if (c.lifecycle !== 'deprecated') reasons.push('not-deprecated');
  if (!c.retirementApproved) reasons.push('retirement-not-approved');
  return reasons;
}
