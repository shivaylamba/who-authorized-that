import {
  AuthorizeResult,
  PolicyDecision,
  isPermission,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  catalogEntityReadPermission,
  catalogEntityValidatePermission,
  catalogLocationReadPermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  retirementInvokePermission,
  retirementReadPermission,
  retirementTargetRetirePermission,
} from '@internal/plugin-retirement-common';
import {
  canInvokeRetirement,
  createRetirementTargetConditionalDecision,
  retirementTargetCriteria,
} from '@internal/plugin-retirement-backend';

const ALLOW: PolicyDecision = { result: AuthorizeResult.ALLOW };
const DENY: PolicyDecision = { result: AuthorizeResult.DENY };

/**
 * Explicit demo policy; replaces the scaffold's allow-all policy.
 *
 * - Reads of catalog and demo resources: allowed for signed-in users.
 * - Retirement action gate: allowed for members of the owning teams.
 * - Retirement of a specific affected entity: conditional on trusted resource
 *   data (owner in the caller's verified claims, development, deprecated,
 *   backend approval). Evaluated by the owning plugin; only a final ALLOW
 *   lets the gated profile proceed.
 * - Every catalog mutation (location create/delete, entity delete, refresh)
 *   and anything unrecognized: denied for users. Plugin service principals
 *   are not evaluated by this policy on Backstage 1.56.
 */
export class DemoPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    if (!user) {
      return DENY;
    }
    const claims = user.info.ownershipEntityRefs.map(r =>
      r.toLocaleLowerCase('en-US'),
    );
    const { permission } = request;

    if (isPermission(permission, retirementTargetRetirePermission)) {
      // Same criteria the retirement plugin uses for delegated-authority checks.
      return createRetirementTargetConditionalDecision(
        permission,
        retirementTargetCriteria(claims),
      );
    }

    if (isPermission(permission, retirementInvokePermission)) {
      return canInvokeRetirement(claims) ? ALLOW : DENY;
    }

    if (
      isPermission(permission, retirementReadPermission) ||
      isPermission(permission, catalogEntityReadPermission) ||
      isPermission(permission, catalogLocationReadPermission) ||
      isPermission(permission, catalogEntityValidatePermission)
    ) {
      return ALLOW;
    }

    // Other read-only permissions from the remaining core plugins.
    if (
      permission.attributes.action === 'read' &&
      !permission.name.startsWith('catalog.')
    ) {
      return ALLOW;
    }

    return DENY;
  }
}
