import { AuthorizeResult, createPermission } from '@backstage/plugin-permission-common';
import { PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  catalogEntityDeletePermission,
  catalogEntityReadPermission,
  catalogEntityRefreshPermission,
  catalogLocationCreatePermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  retirementInvokePermission,
  retirementReadPermission,
  retirementTargetRetirePermission,
} from '@internal/plugin-retirement-common';
import { retirementTargetCriteria } from '@internal/plugin-retirement-backend';
import { DemoPolicy } from './DemoPolicy';

const user = (ref: string, groups: string[]): PolicyQueryUser =>
  ({
    identity: { type: 'user', userEntityRef: ref, ownershipEntityRefs: [ref, ...groups] },
    credentials: {} as PolicyQueryUser['credentials'],
    info: { userEntityRef: ref, ownershipEntityRefs: [ref, ...groups] },
    token: 'not-used',
  }) as PolicyQueryUser;

const alice = user('user:default/alice', ['group:default/checkout-team']);
const bob = user('user:default/bob', ['group:default/visitors']);

describe('DemoPolicy', () => {
  const policy = new DemoPolicy();

  it('gates the retirement action by team membership', async () => {
    expect((await policy.handle({ permission: retirementInvokePermission }, alice)).result).toBe(AuthorizeResult.ALLOW);
    expect((await policy.handle({ permission: retirementInvokePermission }, bob)).result).toBe(AuthorizeResult.DENY);
  });

  it('allows reads to any signed-in user and nothing to anonymous callers', async () => {
    expect((await policy.handle({ permission: retirementReadPermission }, bob)).result).toBe(AuthorizeResult.ALLOW);
    expect((await policy.handle({ permission: catalogEntityReadPermission }, bob)).result).toBe(AuthorizeResult.ALLOW);
    expect((await policy.handle({ permission: retirementReadPermission })).result).toBe(AuthorizeResult.DENY);
  });

  it('returns a conditional decision built from verified claims for each target', async () => {
    const decision = await policy.handle({ permission: retirementTargetRetirePermission }, alice);
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    expect(decision).toMatchObject({
      pluginId: 'retirement-demo',
      resourceType: 'retirement-demo-target',
      conditions: {
        allOf: [
          { rule: 'IS_OWNED_BY_ANY_OF', params: { claims: ['user:default/alice', 'group:default/checkout-team'] } },
          { rule: 'HAS_ENVIRONMENT', params: { environment: 'development' } },
          { rule: 'HAS_LIFECYCLE', params: { lifecycle: 'deprecated' } },
          { rule: 'HAS_RETIREMENT_APPROVAL' },
        ],
      },
    });
  });

  it('builds its resource decision from the shared evaluator criteria', async () => {
    const decision = await policy.handle({ permission: retirementTargetRetirePermission }, alice);
    expect(decision).toMatchObject({
      conditions: retirementTargetCriteria(['user:default/alice', 'group:default/checkout-team']),
    });
  });

  it.each([
    catalogLocationCreatePermission,
    catalogLocationDeletePermission,
    catalogEntityDeletePermission,
    catalogEntityRefreshPermission,
  ])('denies native catalog mutation %s to users', async permission => {
    expect((await policy.handle({ permission }, alice)).result).toBe(AuthorizeResult.DENY);
  });

  it('denies unrecognized mutating permissions by default', async () => {
    const unknown = createPermission({ name: 'other.thing.delete', attributes: { action: 'delete' } });
    expect((await policy.handle({ permission: unknown }, alice)).result).toBe(AuthorizeResult.DENY);
  });
});
