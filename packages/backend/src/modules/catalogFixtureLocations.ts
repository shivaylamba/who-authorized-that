import { createBackendModule } from '@backstage/backend-plugin-api';
import { catalogLocationsExtensionPoint } from '@backstage/plugin-catalog-node';

/**
 * Allows the catalog API to register `file` locations, which is how the demo's
 * disposable fixture targets are registered. Only `file` is allowed (no `url`),
 * so the catalog never reaches out to the network. Which files may be
 * registered is restricted twice more: the demo policy denies location
 * creation to users, and the retirement executor only registers paths from
 * fixtures/manifest.yaml.
 */
export const catalogModuleFixtureLocations = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'demo-fixture-locations',
  register(reg) {
    reg.registerInit({
      deps: { locations: catalogLocationsExtensionPoint },
      async init({ locations }) {
        locations.setAllowedLocationTypes(['file']);
      },
    });
  },
});
