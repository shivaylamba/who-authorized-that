import { TrustedClassification } from '@internal/plugin-retirement-common';
import { explainGatedRule } from '../classification';
import {
  canDelegateRetirement,
  canInvokeRetirement,
  evaluateRetirementTarget,
} from './evaluator';

const base: TrustedClassification = {
  entityRef: 'component:default/x',
  kind: 'Component',
  uid: 'u',
  owner: 'group:default/checkout-team',
  lifecycle: 'deprecated',
  environment: 'development',
  retirementApproved: true,
  version: 'v',
};
const alice = ['user:default/alice', 'group:default/checkout-team'];

describe('shared evaluator', () => {
  it.each<[string, Partial<TrustedClassification>]>([
    ['eligible', {}],
    ['other owner', { owner: 'group:default/payments-team' }],
    ['unknown owner', { owner: undefined }],
    ['production', { environment: 'production' }],
    ['not deprecated', { lifecycle: 'experimental' }],
    ['not approved', { retirementApproved: false }],
  ])('agrees with the explained rule: %s', (_, over) => {
    const r = { ...base, ...over };
    expect(evaluateRetirementTarget(r, alice)).toBe(explainGatedRule(r, alice).length === 0);
  });

  it('denies a missing resource', () => {
    expect(evaluateRetirementTarget(undefined, alice)).toBe(false);
  });

  it('lets agents invoke but never delegate', () => {
    expect(canInvokeRetirement(['group:default/agents'])).toBe(true);
    expect(canDelegateRetirement(['group:default/agents'])).toBe(false);
    expect(canDelegateRetirement(alice)).toBe(true);
    expect(canInvokeRetirement(['group:default/visitors'])).toBe(false);
  });
});
