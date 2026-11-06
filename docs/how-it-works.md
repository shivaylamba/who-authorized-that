# How it works

## What the demo proves

1. **Chapter 1 · The gap (unchecked run on the lab server).** Our action uses a privileged backend
   executor. Without authorizing the original caller first, the caller inherits the
   executor's authority: payments-api is unregistered.
2. **Chapter 2 · The fix (checked run).** Same caller (`user:default/alice`), gate, tool
   schema and executor; the action asks the permission framework, with Alice's credentials,
   whether she may retire **each entity the operation will actually remove**.
3. **Chapter 3 · Agent's own identity (checked run).** The agent signs in as
   its own demo service account and may act only inside a task grant Alice issued
   (`checkout-preview` for MIG-42). `legacy-checkout-worker` — which Alice herself may
   retire — is denied to the agent as outside the task.

The operation is catalog **unregistration** of synthetic records; it stands in for, but
is not, deleting infrastructure or databases.

It does **not** prove prompt-injection prevention, least privilege in general, task
understanding by a model, or that any standard (RFC 8693, MCP Enterprise-Managed
Authorization) creates agent identities or task grants automatically. Task grants are
**custom application logic**. This is an intentionally unsafe custom integration in a
local lab (chapter 1), not a claim about current upstream Backstage behavior.

## Identities

| Identity | How it is established | What it can do |
| --- | --- | --- |
| `user:default/alice` | Dex OIDC sign-in → Backstage session; MCP/CLI via native Backstage OAuth (CIMD + PKCE) | Read demo data; invoke the retirement action (gate); retire only what the resource rule allows (gated) |
| `user:default/bob` | same | Read only; the retirement action is hidden and returns NotFound |
| `user:default/carol` | same | Payments-team member (used for revocation probing) |
| `user:default/mig42-agent` | **demo service account**: its own Dex login → native Backstage OAuth (CIMD + PKCE); catalog annotation `retirement-demo.example.com/account-type: agent` | Owns nothing; invokes the action (group `agents`); in gated mode may retire only what an active task grant covers **and** its delegator may currently retire. Cannot issue, expand or revoke grants. A user-type principal because, on 1.56, a service principal calling through MCP reaches the action as `plugin:mcp-actions` and loses its own identity. |
| `probe-workload` | static external-access token, restricted to plugins `mcp-actions` and `retirement-demo` | Used only by `yarn demo:findings`; the retirement action rejects it as a caller |
| `demo-retirement-executor` (executor) | static external-access token (`DEMO_EXECUTOR_TOKEN`), `accessRestrictions`: plugin `catalog`, permissions `catalog.entity.read`, `catalog.location.read/create/delete` | Catalog location add/remove. Backstage denies every other permission and plugin for it (verified); the executor additionally only touches manifest targets |
| `plugin:retirement-demo` | Backstage plugin-to-plugin service token | Trusted **reads** only (resolution, snapshots) |
| `demo-operator` | static external-access token from `.env` | Only the `retirement-demo` plugin routes (`accessRestrictions`); seed/reset/run bookkeeping/export |

Ownership claims come from `userInfo.getUserInfo(credentials)`; client headers are ignored
(e2e: spoofed `x-backstage-user`/`x-groups` had no effect).

## Execution path and checks

```
MCP client → /api/mcp-actions/v1 (401 without valid token)
  → Actions service (on-behalf-of token keeps the user principal)
  → retirement-demo action router: visibilityPermission retirement-demo.action.retire (else 404)
  → strict zod schema (unknown fields → InputError)
  → RetirementService.retire
      user principal required · ref canonicalized · must be in manifest
      per-location lock · re-resolve affected set · optional expectedVersion
      GATED: authorize retirement-demo.target.retire for EVERY affected entity
             (resourceRef = entityRef@version, conditional decision evaluated by the
              permission backend via our apply-conditions endpoint) — only ALLOW proceeds;
             errors, CONDITIONAL, incomplete set → deny
      GATED + agent account (chapter 3), instead of the caller's own resource permission:
             active task grant bound to this agent, action, task, and covering EVERY
             affected entity (custom logic)  ∩  delegator's CURRENT authority: delegator
             re-resolved from the catalog (exists, human, not suspended, holds the gate),
             same criteria as the policy via the shared evaluator  ∩  the agent's action
             gate (visibilityPermission via the permission framework).
             Grant + delegator authority re-checked immediately before the executor.
      UNGATED LAB: record authorization-skipped (no ALLOW is emitted; applies to every caller)
      recheck version → PrivilegedCatalogExecutor.unregisterLocation (manifest-only)
      catalog read-back until absent → REMOVED_VERIFIED / UNVERIFIED
```

Resource rule (all must hold for every affected entity): owner ∈ caller's verified
ownership claims, environment `development`, lifecycle `deprecated`, backend approval present.

## Containment

- Only `retirement-demo` actions are exposed through MCP (`backend.actions.pluginSources`);
  the plugin refuses to start otherwise. The native `catalog:unregister-entity` action
  returns 404 on both MCP endpoints and its direct invoke route.
- Demo policy denies every catalog mutation permission to users (location create/delete,
  entity delete, refresh). Observed 403s in the e2e suite.
- Backend removed: scaffolder, kubernetes, techdocs, search, proxy, notifications.
- All listeners on 127.0.0.1 (backend 7007, Postgres 5432, Dex 5556); the VM
  firewall allows only SSH and ICMP inbound.
- Mode: missing → gated; unknown → refuse to start; `ungated-lab` (the lab server) additionally
  needs `DEMO_LAB_ENABLED=true` in the process environment (set only by `demo:start:ungated`).
  On the lab server each run records whether it is checked, and the action follows the run;
  the gated server is always checked and refuses to open an unchecked run.
- The executor rejects any location not listed in `fixtures/manifest.yaml`, in both profiles.
- Reset and mode are operator CLI only; no MCP tool or unauthenticated button exists for them.

## Task grants (chapter 3)

- Stored per grant: agent principal, delegator (from verified credentials), task, exact
  action, explicit canonical targets, issue time, expiry (1–60 min), revocation status.
- Issued by a human through `POST /api/retirement-demo/grants` (the dashboard's chapter-3 run,
  the details page, or `yarn demo:grant`); agents get 403. A delegator cannot grant a target they could not retire
  themselves. Strict schema: a client-supplied `delegatorRef` is rejected (400).
- Revocation: by the delegator, or by the operator; operator reset revokes all.
- A grant ID in a request is never authority; the server looks up grants by the verified
  agent principal.
- Concurrency: grant and delegator authority are checked at authorization time and again
  immediately before the executor call. A revocation that lands after that final check
  cannot stop the in-flight catalog call.

## Shared evaluator

`plugins/retirement-backend/src/permissions/evaluator.ts` holds the demo's rules once.
The central policy returns them as a CONDITIONAL decision (evaluated by the permission
backend through our `apply-conditions` endpoint); delegated checks evaluate the same
criteria with `createConditionAuthorizer` for the delegator, whose token is not present on
the agent's request. This validates the **demo's** shared rules; it is not equivalent to
asking an arbitrary third-party Backstage permission policy.

## Known limits

- **Service-principal permission decisions on 1.56.** Permission checks made with a
  service principal's credentials are decided by its `accessRestrictions`, not the central
  policy (`ServerPermissionClient#servicePrincipalDecision`). Calls made on
  behalf of a user keep the user's identity and use the policy. The
  executor therefore runs as a restricted external-access principal (framework-enforced
  permission list) plus a manifest check in code. The restriction lives in
  `backend.auth.externalAccess`, not in the policy file, and cannot scope individual
  locations. The plugin's own unrestricted service identity is used only for reads.
- **Catalog consistency.** Version checks happen inside a per-location in-process lock and
  immediately before mutation, but the catalog API offers no compare-and-delete; a change
  between the recheck and the delete call is theoretically possible. Fixture sources are
  operator-owned files; no SCM consistency is claimed. Single backend instance assumed.
- **Native Catalog UI.** The "Unregister entity" control is shown disabled for Alice;
  the corresponding REST calls return 403.
- **Tokens.** Access tokens are JWTs with `aud: backstage`, valid for 1 hour, accepted by
  MCP and the catalog REST API alike; logout does not invalidate already-issued access tokens
  (they stay valid until they expire).
- **Delegator authority** is the demo's shared rules evaluated on current catalog data plus
  an operator suspension list; it does not consult other policy modules.
- **Evidence store.** A local demo event table, redacted before storage; not an
  immutable or compliance-grade audit log.
- **Native audit events.** Every retirement attempt emits a Backstage auditor event
  `retirement-demo.retire-service` (severity high; initiated → succeeded/failed) with
  operation/correlation IDs, verified caller and kind, outcome, affected refs, resource
  authorization mode, executor subject, whether the executor was attempted, reason codes
  and delegation. Grant issue/revoke emits `retirement-demo.task-grant`. The auditor's
  `actor` field shows `plugin:retirement-demo` because action handlers do not receive the
  HTTP request the auditor derives actors from; the verified caller is in `meta.caller`.
  Native MCP `tool-execution` and catalog `location-mutate` events are also emitted.
