import { Config } from '@backstage/config';
import { DEMO_MODES, DemoMode } from '@internal/plugin-retirement-common';

/**
 * Selects the startup profile.
 *
 * - Missing `retirementDemo.mode` selects `gated`.
 * - Unknown values refuse startup.
 * - `ungated-lab` additionally requires `DEMO_LAB_ENABLED=true` in the
 *   environment; otherwise startup is refused. It can never be chosen by a
 *   tool argument or a web request.
 */
export function resolveDemoMode(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): DemoMode {
  const raw = config.getOptionalString('retirementDemo.mode');
  if (raw === undefined) {
    return 'gated';
  }
  if (!(DEMO_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `Refusing to start: retirementDemo.mode "${raw}" is not one of ${DEMO_MODES.join(', ')}`,
    );
  }
  const mode = raw as DemoMode;
  if (mode === 'ungated-lab' && env.DEMO_LAB_ENABLED !== 'true') {
    throw new Error(
      'Refusing to start the ungated lab profile without DEMO_LAB_ENABLED=true',
    );
  }
  return mode;
}
