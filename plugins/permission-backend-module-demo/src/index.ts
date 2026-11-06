/**
 * Central demo permission policy module.
 *
 * @packageDocumentation
 */

import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { DemoPolicy } from './DemoPolicy';

export { DemoPolicy } from './DemoPolicy';

export default createBackendModule({
  pluginId: 'permission',
  moduleId: 'demo-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new DemoPolicy());
      },
    });
  },
});
