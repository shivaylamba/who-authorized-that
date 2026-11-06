import { ConfigReader } from '@backstage/config';
import { resolveDemoMode } from './mode';

const cfg = (mode?: string) =>
  new ConfigReader(mode === undefined ? {} : { retirementDemo: { mode } });

describe('resolveDemoMode', () => {
  it('selects gated when the mode is missing', () => {
    expect(resolveDemoMode(cfg(), {})).toBe('gated');
  });

  it('refuses unknown modes instead of guessing', () => {
    expect(() => resolveDemoMode(cfg('ungated'), {})).toThrow(/Refusing to start/);
    expect(() => resolveDemoMode(cfg('GATED'), {})).toThrow(/Refusing to start/);
    // An empty value is already rejected by the config reader itself.
    expect(() => resolveDemoMode(cfg(''), {})).toThrow();
  });

  it('requires the explicit lab opt-in for the ungated profile', () => {
    expect(() => resolveDemoMode(cfg('ungated-lab'), {})).toThrow(/DEMO_LAB_ENABLED/);
    expect(() =>
      resolveDemoMode(cfg('ungated-lab'), { DEMO_LAB_ENABLED: '1' }),
    ).toThrow(/DEMO_LAB_ENABLED/);
    expect(resolveDemoMode(cfg('ungated-lab'), { DEMO_LAB_ENABLED: 'true' })).toBe(
      'ungated-lab',
    );
  });

  it('never selects the lab from the environment flag alone', () => {
    expect(resolveDemoMode(cfg('gated'), { DEMO_LAB_ENABLED: 'true' })).toBe('gated');
    expect(resolveDemoMode(cfg(), { DEMO_LAB_ENABLED: 'true' })).toBe('gated');
  });
});
