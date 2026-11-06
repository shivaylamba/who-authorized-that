import { DemoEvent } from '@internal/plugin-retirement-common';
import { requestsFromEvents, rowsFromEvents } from './scenarios';

const ev = (subject: string, entity: string, phase: DemoEvent['phase'], reasonCode?: string) =>
  ({ caller: { type: 'user', subject }, requestedEntityRef: entity, phase, reasonCode }) as DemoEvent;

const CP = 'component:default/checkout-preview';
const PA = 'component:default/payments-api';
const LW = 'component:default/legacy-checkout-worker';

describe('rowsFromEvents', () => {
  it('reads deleted, blocked and untouched for the scenario principal only', () => {
    const rows = rowsFromEvents(
      [
        ev('user:default/mig42-agent', CP, 'verification-succeeded'),
        ev('user:default/mig42-agent', LW, 'denied', 'outside-task-grant'),
        ev('user:default/alice', LW, 'verification-succeeded'),
      ],
      'user:default/mig42-agent',
    );
    expect(rows).toEqual([
      { entityRef: CP, outcome: 'deleted', checkSkipped: false },
      { entityRef: PA, outcome: 'untouched' },
      { entityRef: LW, outcome: 'blocked', reason: 'outside-task-grant' },
    ]);
  });

  it('marks a deletion made without a check', () => {
    const rows = rowsFromEvents(
      [ev('user:default/alice', PA, 'authorization-skipped'), ev('user:default/alice', PA, 'verification-succeeded')],
      'user:default/alice',
    );
    expect(rows[1]).toEqual({ entityRef: PA, outcome: 'deleted', checkSkipped: true });
  });
});

describe('requestsFromEvents', () => {
  const at = (subject: string, entity: string, phase: DemoEvent['phase'], reasonCode?: string) =>
    ({
      caller: { type: 'user', subject },
      actionId: 'retirement-demo:retire-service',
      requestedEntityRef: entity,
      phase,
      reasonCode,
    }) as DemoEvent;

  it('lists requests in the order the agent made them, with checkpoint and result', () => {
    const A = 'user:default/alice';
    expect(
      requestsFromEvents(
        [
          at(A, CP, 'authorized'),
          at(A, CP, 'verification-succeeded'),
          at(A, PA, 'denied', 'not-owned-by-caller'),
          at(A, LW, 'authorization-skipped'),
          { ...at(A, PA, 'authorized'), actionId: 'retirement-demo:preview-retirement' },
        ],
        A,
      ),
    ).toEqual([
      { entityRef: CP, check: 'allowed', outcome: 'deleted', reason: undefined },
      { entityRef: PA, check: 'denied', outcome: 'blocked', reason: 'not-owned-by-caller' },
      { entityRef: LW, check: 'none', outcome: 'pending', reason: undefined },
    ]);
  });
});
