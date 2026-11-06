/*
 * Backend composition for the Who Authorized That? demo.
 *
 * Deliberately small: no scaffolder, kubernetes, techdocs, search or proxy, so
 * the only catalog mutation paths are the native catalog REST API (denied to
 * users by the demo policy) and the retirement plugin's narrow executor.
 */

import { createBackend } from '@backstage/backend-defaults';
import { catalogModuleFixtureLocations } from './modules/catalogFixtureLocations';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));

// auth: local OIDC sign-in (Dex) + Backstage's native OAuth server for MCP/CLI clients
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));

// catalog
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
backend.add(catalogModuleFixtureLocations);

// permissions: explicit demo policy instead of allow-all
backend.add(import('@backstage/plugin-permission-backend'));
backend.add(import('@internal/plugin-permission-backend-module-demo'));

// user settings storage for the frontend (its storage API depends on signals)
backend.add(import('@backstage/plugin-user-settings-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// MCP actions (native) + the custom retirement demo actions
backend.add(import('@backstage/plugin-mcp-actions-backend'));
backend.add(import('@internal/plugin-retirement-backend'));

backend.start();
