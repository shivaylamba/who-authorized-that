import { createPermission } from '@backstage/plugin-permission-common';
import { RETIREMENT_TARGET_RESOURCE_TYPE } from './constants';

/**
 * Action-level gate: may this principal invoke the retirement action at all?
 * Used as the action's native `visibilityPermission`. Alice is allowed this in
 * both profiles; it says nothing about which resources may be affected.
 */
export const retirementInvokePermission = createPermission({
  name: 'retirement-demo.action.retire',
  attributes: { action: 'update' },
});

/** Action-level gate for the read-only demo actions. */
export const retirementReadPermission = createPermission({
  name: 'retirement-demo.action.read',
  attributes: { action: 'read' },
});

/**
 * Resource-level authority: may this caller retire this specific affected
 * entity? Evaluated once per affected entity, in the gated profile only.
 */
export const retirementTargetRetirePermission = createPermission({
  name: 'retirement-demo.target.retire',
  attributes: { action: 'delete' },
  resourceType: RETIREMENT_TARGET_RESOURCE_TYPE,
});

export const retirementPermissions = [
  retirementInvokePermission,
  retirementReadPermission,
  retirementTargetRetirePermission,
];
