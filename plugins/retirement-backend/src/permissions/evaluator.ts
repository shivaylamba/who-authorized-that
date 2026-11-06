import {
  AuthorizeResult,
  PermissionCondition,
  PermissionCriteria,
} from '@backstage/plugin-permission-common';
import {
  PermissionRuleset,
  createConditionAuthorizer,
} from '@backstage/plugin-permission-node';
import {
  RETIREMENT_PLUGIN_ID,
  RETIREMENT_TARGET_RESOURCE_TYPE,
  TrustedClassification,
} from '@internal/plugin-retirement-common';
import { retirementTargetConditions, retirementTargetRules } from './rules';

/**
 * The single source of the demo's authorization rules. Used by:
 *  - the central permission policy (plugins/permission-backend-module-demo),
 *    which returns these criteria as a CONDITIONAL decision that the
 *    permission backend evaluates through our apply-conditions endpoint; and
 *  - delegated-authority checks for agents, which evaluate the same criteria
 *    for the delegator (Alice) with createConditionAuthorizer, because the
 *    delegator's own token is not present on the agent's request.
 *
 * This validates the demo's shared rules. It is not equivalent to asking an
 * arbitrary third-party Backstage permission policy.
 */

/** Groups whose members (and demo service accounts) may invoke the retirement action at all. */
export const RETIREMENT_INVOKERS = [
  'group:default/checkout-team',
  'group:default/payments-team',
  'group:default/agents',
];

/** Groups whose members may delegate retirement to an agent. Agents are never delegators. */
export const RETIREMENT_DELEGATORS = [
  'group:default/checkout-team',
  'group:default/payments-team',
];

const normalize = (claims: string[]) => claims.map(c => c.toLocaleLowerCase('en-US'));

export function canInvokeRetirement(ownershipClaims: string[]): boolean {
  return normalize(ownershipClaims).some(c => RETIREMENT_INVOKERS.includes(c));
}

export function canDelegateRetirement(ownershipClaims: string[]): boolean {
  return normalize(ownershipClaims).some(c => RETIREMENT_DELEGATORS.includes(c));
}

/** Resource rule: owned by the caller's claims, development, deprecated, approved. */
export function retirementTargetCriteria(
  ownershipClaims: string[],
): PermissionCriteria<PermissionCondition<typeof RETIREMENT_TARGET_RESOURCE_TYPE>> {
  return {
    allOf: [
      retirementTargetConditions.isOwnedByAnyOf({ claims: normalize(ownershipClaims) }),
      retirementTargetConditions.hasEnvironment({ environment: 'development' }),
      retirementTargetConditions.hasLifecycle({ lifecycle: 'deprecated' }),
      retirementTargetConditions.hasRetirementApproval(),
    ],
  };
}

const ruleset: PermissionRuleset<TrustedClassification> = {
  getRuleByName(name: string) {
    const rule = Object.values(retirementTargetRules).find(r => r.name === name);
    if (!rule) {
      throw new Error(`Unknown retirement rule ${name}`);
    }
    return rule as unknown as ReturnType<PermissionRuleset<TrustedClassification>['getRuleByName']>;
  },
};

const authorize = createConditionAuthorizer(ruleset);

/** Evaluates the shared criteria for given claims against trusted resource data. */
export function evaluateRetirementTarget(
  resource: TrustedClassification | undefined,
  ownershipClaims: string[],
): boolean {
  return authorize(
    {
      result: AuthorizeResult.CONDITIONAL,
      pluginId: RETIREMENT_PLUGIN_ID,
      resourceType: RETIREMENT_TARGET_RESOURCE_TYPE,
      conditions: retirementTargetCriteria(ownershipClaims),
    },
    resource,
  );
}
