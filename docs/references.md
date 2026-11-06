# References and how they were used

Technical claims in this repository rest on the installed package sources and on behavior
observed on the running server (`yarn demo:findings`, `yarn demo:test`).

| ID | Reference | Used for | Status in this repo |
| --- | --- | --- | --- |
| B1 | https://backstage.io/docs/ai/mcp-actions/ | MCP Actions setup, named/default endpoints, CIMD | Behavior checked in `@backstage/plugin-mcp-actions-backend` 0.2.3 source |
| B2 | https://backstage.io/docs/backend-system/core-services/actions-registry/ | Action registration, visibilityPermission | Checked in `backend-defaults` alpha source |
| B3 | https://backstage.io/docs/backend-system/core-services/actions/ | Listing/invoking actions, denial behavior | Observed: visibility denial → 404 / NotFoundError |
| B4 | https://backstage.io/docs/backend-system/core-services/auth/ | Credential validation, plugin tokens | Used for executor service credentials |
| B5 | https://backstage.io/docs/auth/service-to-service-auth/ | External access + access restrictions | Operator static token restricted to `retirement-demo` |
| B6 | https://backstage.io/docs/backend-system/core-services/permissions/ | Authorizing with caller credentials | Used in gated branch |
| B7 | https://backstage.io/docs/backend-system/core-services/permissions-registry/ | Resource type + rules | `addResourceType` with `getResources` |
| B8 | https://backstage.io/docs/permissions/writing-a-policy/ | Central policy, conditional decisions | `plugins/permission-backend-module-demo` |
| B9 | https://backstage.io/docs/permissions/custom-rules/ | Typed rules | `createPermissionRule` with zod v4 params |
| B10 | https://backstage.io/docs/features/software-templates/authorizing-scaffolder-template-details/ | Adjacent boundary | Scaffolder removed from this backend |
| B11 | https://backstage.io/docs/overview/threat-model/ | Downstream authority framing | [how-it-works.md](how-it-works.md) |
| B12 | https://backstage.io/docs/releases/v1.43.0/ | Historical delegated tokens | Context only |
| B13 | https://backstage.io/docs/releases/v1.53.0/ | CIMD, revocation, DCR deprecation | Installed code reads `auth.clientIdMetadataDocuments`; revocation behavior observed |
| B14 | https://backstage.io/docs/releases/v1.54.0/ | MCP audit events | Observed `tool-execution` auditor events in backend log |
| B15 | https://backstage.io/docs/releases/v1.55.0/ | Default endpoint alongside named servers | Observed: default always serves all registered actions |
| B16 | https://backstage.io/docs/next/releases/v1.57.0-next.0-changelog/ | Prerelease | Not used |
| R1 | https://github.com/backstage/backstage/issues/34617 | Motivation (location delete vs entity permissions) | Reporter claim; native `deleteLocation` checks only the basic location permission in 4.0.2 (read in source). Not claimed as a current exploitable vulnerability. |
| R2 | https://github.com/backstage/backstage/pull/34631 | Affected-set authorization idea | Closed, not merged; not imported |
| R3 | https://roadie.io/backstage-weekly/139-mcp-permissions-cve-context-window/ | Context | Context only |
| R4 | https://invariantlabs.ai/blog/mcp-github-vulnerability | Issue-steering narrative | Our scenario is a new reconstruction |
| R5 | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/333 | Agent/client scope separation | Motivation only |
| R6 | https://docs.cloud.google.com/mcp/authenticate-mcp | Separate agent identities | Not equivalent to Backstage defaults |
| M1–M5 | MCP specification and blog | Protocol context | Plugin implements up to `2025-11-25`, not `2026-07-28` |
| O1 | RFC 8693 | Token exchange | Not offered by Backstage 1.56 (chapter 4); task grants are custom instead |
| O2 | RFC 8707 | Resource indicators | Not used by this Backstage version's flow (not observed) |
| O3 | RFC 9728 | Protected resource metadata | Served by the MCP plugin (verified) |
| O4 | RFC 9207 | Issuer identification | Not verified |
| O5 | RFC 7636 | PKCE | S256 used by the Backstage CLI client (verified); server also advertises `plain` |
