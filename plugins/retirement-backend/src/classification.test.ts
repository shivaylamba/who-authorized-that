import { Entity } from '@backstage/catalog-model';
import {
  affectedSetVersion,
  classifyEntity,
  explainGatedRule,
  parseResourceRef,
  toResourceRef,
} from './classification';

function component(overrides: {
  name?: string;
  owners?: string[];
  lifecycle?: string;
  environment?: string;
}): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: overrides.name ?? 'checkout-preview',
      namespace: 'default',
      uid: 'uid-1',
      annotations: overrides.environment
        ? { 'retirement-demo.example.com/environment': overrides.environment }
        : {},
    },
    spec: { lifecycle: overrides.lifecycle ?? 'deprecated', owner: 'ignored' },
    relations: (overrides.owners ?? ['group:default/checkout-team']).map(targetRef => ({
      type: 'ownedBy',
      targetRef,
    })),
  };
}

const approval = {
  entityRef: 'component:default/checkout-preview',
  approvalId: 'CHG-1042',
  approvedBy: 'group:default/checkout-team',
};

describe('classifyEntity', () => {
  it('takes ownership from stitched relations, not spec.owner', () => {
    const c = classifyEntity(component({ environment: 'development' }), approval);
    expect(c.owner).toBe('group:default/checkout-team');
    expect(c.retirementApproved).toBe(true);
    expect(c.environment).toBe('development');
  });

  it('treats ambiguous or missing ownership as unknown', () => {
    expect(classifyEntity(component({ owners: [] }), approval).owner).toBeUndefined();
    expect(
      classifyEntity(
        component({ owners: ['group:default/a', 'group:default/b'] }),
        approval,
      ).owner,
    ).toBeUndefined();
  });

  it('changes version whenever an authoritative field changes', () => {
    const base = classifyEntity(component({ environment: 'development' }), approval);
    const variants = [
      classifyEntity(component({ environment: 'production' }), approval),
      classifyEntity(component({ environment: 'development', lifecycle: 'production' }), approval),
      classifyEntity(component({ environment: 'development', owners: ['group:default/payments-team'] }), approval),
      classifyEntity(component({ environment: 'development' }), undefined),
    ];
    for (const v of variants) {
      expect(v.version).not.toBe(base.version);
    }
    expect(classifyEntity(component({ environment: 'development' }), approval).version).toBe(
      base.version,
    );
  });
});

describe('resource refs and affected-set versions', () => {
  it('round-trips ref@version and rejects malformed refs', () => {
    const c = classifyEntity(component({ environment: 'development' }), approval);
    expect(parseResourceRef(toResourceRef(c))).toEqual({
      entityRef: c.entityRef,
      version: c.version,
    });
    expect(parseResourceRef('component:default/x')).toBeUndefined();
    expect(parseResourceRef('component:default/x@nothex')).toBeUndefined();
  });

  it('versions the location and every member of the affected set', () => {
    const a = classifyEntity(component({ name: 'a', environment: 'development' }), undefined);
    const b = classifyEntity(component({ name: 'b', environment: 'development' }), undefined);
    const loc = { id: 'l1', target: '/fixtures/x.yaml' };
    expect(affectedSetVersion(loc, [a, b])).toBe(affectedSetVersion(loc, [b, a]));
    expect(affectedSetVersion(loc, [a])).not.toBe(affectedSetVersion(loc, [a, b]));
    expect(affectedSetVersion({ ...loc, id: 'l2' }, [a])).not.toBe(
      affectedSetVersion(loc, [a]),
    );
  });
});

describe('explainGatedRule', () => {
  const claims = ['user:default/alice', 'group:default/checkout-team'];

  it('explains every failed condition for payments-api', () => {
    const payments = classifyEntity(
      component({
        name: 'payments-api',
        owners: ['group:default/payments-team'],
        lifecycle: 'production',
        environment: 'production',
      }),
      undefined,
    );
    expect(explainGatedRule(payments, claims)).toEqual([
      'not-owned-by-caller',
      'not-development-environment',
      'not-deprecated',
      'retirement-not-approved',
    ]);
  });

  it('shows that ownership alone is insufficient for checkout-v2', () => {
    const v2 = classifyEntity(
      component({ name: 'checkout-v2', lifecycle: 'experimental', environment: 'development' }),
      undefined,
    );
    expect(explainGatedRule(v2, claims)).toEqual(['not-deprecated', 'retirement-not-approved']);
  });
});
