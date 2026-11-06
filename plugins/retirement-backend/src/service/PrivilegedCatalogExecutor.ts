import { DiscoveryService } from '@backstage/backend-plugin-api';
import { CatalogClient } from '@backstage/catalog-client';
import { NotAllowedError, NotFoundError } from '@backstage/errors';
import { ManifestGuard, ManifestTarget } from '../manifest';

/**
 * Internal adapter that performs catalog mutations. It is never exposed
 * through a route, and its credential is never returned to a caller.
 *
 * Two independent limits apply in every profile, including the lab:
 *  1. Framework-enforced: it authenticates to the catalog with a dedicated
 *     static external-access token whose `accessRestrictions` (app-config.yaml)
 *     allow only the catalog plugin and only `catalog.entity.read`,
 *     `catalog.location.read`, `catalog.location.create` and
 *     `catalog.location.delete`. Backstage denies any other permission for
 *     this principal and rejects the token at every other plugin.
 *  2. Code-enforced: it only touches locations listed in fixtures/manifest.yaml.
 */
export interface CatalogExecutor {
  readonly subject: string;
  unregisterLocation(location: { id: string; target: string }): Promise<void>;
  registerLocation(target: ManifestTarget): Promise<{ id: string }>;
}

export const EXECUTOR_SUBJECT = 'demo-retirement-executor';

export class PrivilegedCatalogExecutor implements CatalogExecutor {
  readonly subject = EXECUTOR_SUBJECT;
  private readonly catalog: CatalogClient;

  constructor(
    discovery: DiscoveryService,
    private readonly token: string,
    private readonly guard: ManifestGuard,
  ) {
    this.catalog = new CatalogClient({ discoveryApi: discovery });
  }

  async unregisterLocation(location: { id: string; target: string }) {
    if (!this.guard.targetForLocation(location.target)) {
      throw new NotAllowedError('executor-target-outside-manifest');
    }
    // Re-read by ID so a swapped ID cannot point the executor elsewhere.
    const live = await this.catalog.getLocationById(location.id, { token: this.token });
    if (!live) {
      throw new NotFoundError('location-already-absent');
    }
    if (live.type !== 'file' || live.target !== location.target) {
      throw new NotAllowedError('executor-location-mismatch');
    }
    await this.catalog.removeLocationById(location.id, { token: this.token });
  }

  async registerLocation(target: ManifestTarget) {
    if (this.guard.targetForLocation(target.locationTarget) !== target) {
      throw new NotAllowedError('executor-target-outside-manifest');
    }
    const { location } = await this.catalog.addLocation(
      { type: 'file', target: target.locationTarget },
      { token: this.token },
    );
    return { id: location.id };
  }
}
