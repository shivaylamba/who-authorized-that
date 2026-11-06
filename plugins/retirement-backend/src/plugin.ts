import path from 'node:path';
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import {
  RETIREMENT_PLUGIN_ID,
  TrustedClassification,
  retirementTargetRetirePermission,
} from '@internal/plugin-retirement-common';
import { registerRetirementActions } from './actions/registerActions';
import { parseResourceRef } from './classification';
import { DemoStore } from './database/DemoStore';
import { ManifestGuard, loadManifest } from './manifest';
import { resolveDemoMode } from './mode';
import {
  retirementTargetResourceRef,
  retirementTargetRules,
} from './permissions/rules';
import { createRouter } from './router/createRouter';
import { PrivilegedCatalogExecutor } from './service/PrivilegedCatalogExecutor';
import { RetirementService } from './service/RetirementService';
import { TrustedResolver } from './service/TrustedResolver';

/**
 * Who Authorized That? retirement demo backend plugin.
 *
 * @public
 */
export const retirementPlugin = createBackendPlugin({
  pluginId: RETIREMENT_PLUGIN_ID,
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        userInfo: coreServices.userInfo,
        actionsRegistry: actionsRegistryServiceRef,
        catalog: catalogServiceRef,
        discovery: coreServices.discovery,
        auditor: coreServices.auditor,
      },
      async init({
        logger,
        config,
        auth,
        httpAuth,
        httpRouter,
        database,
        permissions,
        permissionsRegistry,
        userInfo,
        actionsRegistry,
        catalog,
        discovery,
        auditor,
      }) {
        const mode = resolveDemoMode(config);

        // Containment: only this plugin's actions may be exposed over MCP.
        const sources = config.getOptionalStringArray('backend.actions.pluginSources');
        if (!sources || sources.length !== 1 || sources[0] !== RETIREMENT_PLUGIN_ID) {
          throw new Error(
            `Refusing to start: backend.actions.pluginSources must be exactly [${RETIREMENT_PLUGIN_ID}], got ${JSON.stringify(
              sources,
            )}`,
          );
        }

        const fixturesDir = path.resolve(
          config.getOptionalString('retirementDemo.fixturesDir') ?? '../../fixtures',
        );
        const guard = new ManifestGuard(loadManifest(fixturesDir));
        const store = await DemoStore.create(await database.getClient());
        const resolver = new TrustedResolver(catalog, auth, store, guard);
        // Dedicated, framework-restricted credential for catalog mutations.
        const executorToken = config.getOptionalString('retirementDemo.executorToken');
        if (!executorToken) {
          throw new Error(
            'Refusing to start: retirementDemo.executorToken (DEMO_EXECUTOR_TOKEN) is not configured',
          );
        }
        const executor = new PrivilegedCatalogExecutor(discovery, executorToken, guard);
        const service = new RetirementService({
          mode,
          logger,
          auth,
          permissions,
          userInfo,
          store,
          guard,
          resolver,
          executor,
          auditor,
        });

        permissionsRegistry.addResourceType({
          resourceRef: retirementTargetResourceRef,
          permissions: [retirementTargetRetirePermission],
          rules: Object.values(retirementTargetRules),
          // Called by the permission backend to evaluate conditional decisions.
          // A ref whose version no longer matches resolves to nothing, which
          // the framework treats as DENY.
          getResources: async resourceRefs => {
            const out: Array<TrustedClassification | undefined> = [];
            for (const resourceRef of resourceRefs) {
              const parsed = parseResourceRef(resourceRef);
              if (!parsed || !guard.isManagedEntityRef(parsed.entityRef)) {
                out.push(undefined);
                continue;
              }
              const current = await resolver.classify(parsed.entityRef);
              out.push(current && current.version === parsed.version ? current : undefined);
            }
            return out;
          },
        });

        registerRetirementActions(actionsRegistry, service);

        httpRouter.use(
          await createRouter({
            logger,
            config,
            auth,
            httpAuth,
            userInfo,
            store,
            service,
            resolver,
            guard,
            mode,
          }),
        );

        const run = await store.startRun(mode, 'backend-start');
        if (mode === 'ungated-lab') {
          logger.warn(
            'INTENTIONALLY UNSAFE LAB PROFILE: retire-service skips affected-resource authorization. Demo fixtures only.',
          );
        }
        logger.info(
          `Retirement demo started in ${mode} mode; run ${run.runId}; fixtures ${fixturesDir}`,
        );
      },
    });
  },
});
