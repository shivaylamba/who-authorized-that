import { TrustedClassification } from '@internal/plugin-retirement-common';
import { retirementTargetRules } from './rules';

const base: TrustedClassification = {
  entityRef: 'component:default/checkout-preview',
  kind: 'Component',
  uid: 'u',
  owner: 'group:default/checkout-team',
  lifecycle: 'deprecated',
  environment: 'development',
  retirementApproved: true,
  approvalId: 'CHG-1042',
  version: 'v',
};

describe('retirement target permission rules', () => {
  const { isOwnedByAnyOf, hasEnvironment, hasLifecycle, hasRetirementApproval } =
    retirementTargetRules;

  it('matches ownership only against the supplied verified claims', () => {
    expect(isOwnedByAnyOf.apply(base, { claims: ['group:default/checkout-team'] })).toBe(true);
    expect(isOwnedByAnyOf.apply(base, { claims: ['Group:Default/Checkout-Team'] })).toBe(true);
    expect(isOwnedByAnyOf.apply(base, { claims: ['group:default/payments-team'] })).toBe(false);
    expect(isOwnedByAnyOf.apply({ ...base, owner: undefined }, { claims: ['group:default/checkout-team'] })).toBe(false);
    expect(isOwnedByAnyOf.apply(base, { claims: [] })).toBe(false);
  });

  it('requires exact environment and lifecycle values', () => {
    expect(hasEnvironment.apply(base, { environment: 'development' })).toBe(true);
    expect(hasEnvironment.apply({ ...base, environment: undefined }, { environment: 'development' })).toBe(false);
    expect(hasLifecycle.apply(base, { lifecycle: 'deprecated' })).toBe(true);
    expect(hasLifecycle.apply({ ...base, lifecycle: 'production' }, { lifecycle: 'deprecated' })).toBe(false);
  });

  it('requires backend approval', () => {
    expect(hasRetirementApproval.apply(base, undefined)).toBe(true);
    expect(hasRetirementApproval.apply({ ...base, retirementApproved: false }, undefined)).toBe(false);
  });
});
