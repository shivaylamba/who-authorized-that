import { AuthService, BackstageCredentials } from '@backstage/backend-plugin-api';
import {
  ANNOTATION_ORIGIN_LOCATION,
  Entity,
  parseLocationRef,
  stringifyEntityRef,
  stringifyLocationRef,
} from '@backstage/catalog-model';
import { CatalogService } from '@backstage/plugin-catalog-node';
import {
  CatalogSnapshot,
  TrustedClassification,
} from '@internal/plugin-retirement-common';
import { affectedSetVersion, classifyEntity } from '../classification';
import { DemoStore } from '../database/DemoStore';
import { ManifestGuard } from '../manifest';

export type AffectedSet = {
  requestedEntityRef: string;
  present: boolean;
  requested?: TrustedClassification;
  location?: { id: string; target: string };
  /** The catalog Location entity created for this registration itself. */
  registrationEntityRef?: string;
  affected: TrustedClassification[];
  complete: boolean;
  problems: string[];
  version?: string;
};

/** The read surface the retirement service depends on (fakeable in tests). */
export type TargetResolver = Pick<
  TrustedResolver,
  'getEntity' | 'classify' | 'resolveAffectedSet' | 'snapshot' | 'findLocationForTarget'
>;

/**
 * Reads trusted catalog data with the plugin's own narrow service credentials.
 * These credentials are only ever used for reads here; mutation lives in the
 * PrivilegedCatalogExecutor.
 */
export class TrustedResolver {
  constructor(
    private readonly catalog: CatalogService,
    private readonly auth: AuthService,
    private readonly store: DemoStore,
    private readonly guard: ManifestGuard,
  ) {}

  private async readCredentials(): Promise<BackstageCredentials> {
    return this.auth.getOwnServiceCredentials();
  }

  async getEntity(entityRef: string): Promise<Entity | undefined> {
    return this.catalog.getEntityByRef(entityRef, {
      credentials: await this.readCredentials(),
    });
  }

  async classify(entityRef: string): Promise<TrustedClassification | undefined> {
    const entity = await this.getEntity(entityRef);
    if (!entity) return undefined;
    const ref = stringifyEntityRef(entity).toLocaleLowerCase('en-US');
    return classifyEntity(entity, await this.store.getApproval(ref));
  }

  /**
   * Resolves the complete set of entities that unregistering the requested
   * entity's origin location would remove. Discovery uses the catalog's
   * location-by-entity lookup and the origin-location annotation, then
   * cross-checks the result against the operator manifest. Any disagreement
   * marks the set incomplete, which denies in the gated profile.
   */
  async resolveAffectedSet(requestedEntityRef: string): Promise<AffectedSet> {
    const credentials = await this.readCredentials();
    const problems: string[] = [];
    const entity = await this.catalog.getEntityByRef(requestedEntityRef, {
      credentials,
    });
    if (!entity) {
      return {
        requestedEntityRef,
        present: false,
        affected: [],
        complete: false,
        problems: ['entity-absent'],
      };
    }

    const requested = classifyEntity(
      entity,
      await this.store.getApproval(requestedEntityRef),
    );

    const originRef = entity.metadata.annotations?.[ANNOTATION_ORIGIN_LOCATION];
    const location = await this.catalog
      .getLocationByEntity(requestedEntityRef, { credentials })
      .catch(() => undefined);
    if (!originRef || !location) {
      return {
        requestedEntityRef,
        present: true,
        requested,
        affected: [requested],
        complete: false,
        problems: ['location-unresolved'],
      };
    }

    const origin = parseLocationRef(originRef);
    if (origin.type !== location.type || origin.target !== location.target) {
      problems.push('origin-location-mismatch');
    }
    if (!this.guard.targetForLocation(location.target)) {
      problems.push('location-outside-manifest');
    }

    const locationRef = stringifyLocationRef({
      type: location.type,
      target: location.target,
    });
    const { items } = await this.catalog.getEntities(
      {
        filter: {
          [`metadata.annotations.${ANNOTATION_ORIGIN_LOCATION}`]: locationRef,
        },
      },
      { credentials },
    );

    let registrationEntityRef: string | undefined;
    const affectedEntities: Entity[] = [];
    for (const item of items) {
      const isRegistration =
        item.kind === 'Location' &&
        item.spec?.type === location.type &&
        item.spec?.target === location.target;
      if (isRegistration) {
        registrationEntityRef = stringifyEntityRef(item).toLocaleLowerCase('en-US');
      } else if (item.kind === 'Location') {
        problems.push('nested-location-unsupported');
      } else {
        affectedEntities.push(item);
      }
    }

    const affected: TrustedClassification[] = [];
    for (const item of affectedEntities) {
      const ref = stringifyEntityRef(item).toLocaleLowerCase('en-US');
      affected.push(classifyEntity(item, await this.store.getApproval(ref)));
    }
    affected.sort((a, b) => a.entityRef.localeCompare(b.entityRef));

    // Cross-check discovery against the operator manifest for this location.
    const target = this.guard.targetForLocation(location.target);
    const discovered = new Set(affected.map(a => a.entityRef));
    if (!discovered.has(requested.entityRef)) {
      problems.push('requested-entity-not-in-affected-set');
    }
    for (const a of affected) {
      if (!this.guard.isManagedEntityRef(a.entityRef)) {
        problems.push('unmanaged-entity-in-location');
      }
    }
    if (target) {
      for (const expected of target.entityRefs) {
        if (!discovered.has(expected)) {
          problems.push('affected-set-incomplete');
          break;
        }
      }
    }

    const loc = { id: location.id, target: location.target };
    return {
      requestedEntityRef,
      present: true,
      requested,
      location: loc,
      registrationEntityRef,
      affected,
      complete: problems.length === 0,
      problems,
      version: affectedSetVersion(loc, affected),
    };
  }

  /** Before/after snapshot of every demo-managed entity and location. */
  async snapshot(): Promise<CatalogSnapshot> {
    const credentials = await this.readCredentials();
    const refs = this.guard.allManagedEntityRefs();
    const { items } = await this.catalog.getEntitiesByRefs(
      { entityRefs: refs },
      { credentials },
    );
    const { items: locations } = await this.catalog.getLocations({}, { credentials });
    return {
      takenAt: new Date().toISOString(),
      entities: refs.map((entityRef, i) => ({
        entityRef,
        present: Boolean(items[i]),
        uid: items[i]?.metadata.uid,
      })),
      locations: locations
        .filter(l => this.guard.targetForLocation(l.target))
        .map(l => ({ id: l.id, target: l.target })),
    };
  }

  async findLocationForTarget(
    locationTarget: string,
  ): Promise<{ id: string; target: string } | undefined> {
    const credentials = await this.readCredentials();
    const { items } = await this.catalog.getLocations({}, { credentials });
    const found = items.find(l => l.type === 'file' && l.target === locationTarget);
    return found ? { id: found.id, target: found.target } : undefined;
  }
}
