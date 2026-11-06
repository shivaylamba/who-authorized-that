import {
  createConditionExports,
  createPermissionResourceRef,
  createPermissionRule,
} from '@backstage/plugin-permission-node';
import {
  RETIREMENT_PLUGIN_ID,
  RETIREMENT_TARGET_RESOURCE_TYPE,
  TrustedClassification,
} from '@internal/plugin-retirement-common';
import { z } from 'zod';

/** Query shape for this resource type. The demo only evaluates loaded resources. */
export type RetirementTargetQuery = { rule: string; params?: unknown };

export const retirementTargetResourceRef = createPermissionResourceRef<
  TrustedClassification,
  RetirementTargetQuery
>().with({
  pluginId: RETIREMENT_PLUGIN_ID,
  resourceType: RETIREMENT_TARGET_RESOURCE_TYPE,
});

const isOwnedByAnyOf = createPermissionRule({
  name: 'IS_OWNED_BY_ANY_OF',
  description: 'Allow when the trusted catalog owner is one of the given ownership claims',
  resourceRef: retirementTargetResourceRef,
  paramsSchema: z.object({
    claims: z.array(z.string()).describe('Verified ownership entity refs'),
  }),
  apply: (resource, { claims }) =>
    resource.owner !== undefined &&
    claims.map(c => c.toLocaleLowerCase('en-US')).includes(resource.owner),
  toQuery: params => ({ rule: 'IS_OWNED_BY_ANY_OF', params }),
});

const hasEnvironment = createPermissionRule({
  name: 'HAS_ENVIRONMENT',
  description: 'Allow when the operator-owned environment classification matches',
  resourceRef: retirementTargetResourceRef,
  paramsSchema: z.object({ environment: z.string() }),
  apply: (resource, { environment }) => resource.environment === environment,
  toQuery: params => ({ rule: 'HAS_ENVIRONMENT', params }),
});

const hasLifecycle = createPermissionRule({
  name: 'HAS_LIFECYCLE',
  description: 'Allow when the catalog lifecycle matches',
  resourceRef: retirementTargetResourceRef,
  paramsSchema: z.object({ lifecycle: z.string() }),
  apply: (resource, { lifecycle }) => resource.lifecycle === lifecycle,
  toQuery: params => ({ rule: 'HAS_LIFECYCLE', params }),
});

const hasRetirementApproval = createPermissionRule({
  name: 'HAS_RETIREMENT_APPROVAL',
  description: 'Allow when the backend approvals table approves retirement',
  resourceRef: retirementTargetResourceRef,
  apply: resource => resource.retirementApproved === true,
  toQuery: () => ({ rule: 'HAS_RETIREMENT_APPROVAL' }),
});

export const retirementTargetRules = {
  isOwnedByAnyOf,
  hasEnvironment,
  hasLifecycle,
  hasRetirementApproval,
};

/** Condition factories for permission policies (used by the demo policy module). */
export const {
  conditions: retirementTargetConditions,
  createConditionalDecision: createRetirementTargetConditionalDecision,
} = createConditionExports({
  resourceRef: retirementTargetResourceRef,
  rules: retirementTargetRules,
});
