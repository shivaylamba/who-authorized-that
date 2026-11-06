# Setup

## Install (fresh machine)

Prerequisites: Node 22, corepack (Yarn 4), Docker with compose. On Linux also
`build-essential`.

```sh
yarn install --immutable
yarn demo:env:init                 # writes .env with random local secrets (never printed)
yarn demo:infra:up                 # Postgres + Dex, both on 127.0.0.1
npx playwright install --with-deps chromium   # scripted logins and browser tests
yarn demo:build                    # type check + build the frontend served by the backend
yarn demo:start:ungated            # the lab server (see below)
yarn demo:seed
yarn demo:login alice && yarn demo:login bob && yarn demo:login mig42-agent
yarn demo:findings                 # measurements shown in chapter 4
yarn demo:doctor
```

Open <http://localhost:7007/identity-boundary-demo> and sign in with Local Dex as
`alice@demo.example.com` (password: `DEMO_ALICE_PASSWORD` in `.env`).

Logins use native Backstage OAuth (CIMD + PKCE) through the Backstage CLI. Tokens last one
hour and refresh automatically; run `yarn demo:login <user>` again if one stops working.

## Two server profiles

| Command | Profile | Chapters |
| --- | --- | --- |
| `yarn demo:start:ungated` | **Lab server.** Requires `DEMO_LAB_ENABLED=true`, which this command sets for its own process only. Each run chooses whether the resource check runs. | 1, 2, 3, 4 |
| `yarn demo:start:gated` | **Safe server.** Every run is checked; it refuses to open an unchecked run. | 2, 3, 4 |

Use the lab server for the talk. Stop either with `yarn demo:stop`.

## Remote VM and presenter laptop

The demo binds only to 127.0.0.1. To present from a laptop while it runs on a VM:

```sh
cp presenter/local.example.sh presenter/local.sh   # set VM_HOST and VM_KEY (gitignored)
./presenter/prepare.sh       # services, fresh logins, measurements, lab server, doctor
./presenter/tunnel.sh        # forwards 7007 (Backstage) and 5556 (Dex); keep it open
./presenter/password.sh alice
```

`./presenter/vm.sh <yarn script>` runs any `demo:*` command on the VM.

## Live AI

Put a Nebius Token Factory key in `.env` as `NEBIUS_API_KEY`, then switch on **Live AI** on
the dashboard. The model (`reflection/beam`) receives only the legitimate prompt and the MCP
tools; its full transcript is stored with the run. It is not deterministic: it may ignore the
planted line, and chapter 1 then says so.

From the CLI: `yarn demo:live`, `yarn demo:live:agent` (as `mig42-agent`, needs a grant from
`yarn demo:grant`), `yarn demo:live:batch` (five trials).

## Your own MCP client

`clients/claude-code.mcp.json` points an MCP client at
`http://localhost:7007/api/mcp-actions/v1`. The client signs in through Backstage's OAuth
flow (CIMD) as whichever demo user completes the browser login.

## Commands

| Command | What it does |
| --- | --- |
| `yarn demo:doctor` | Checks prerequisites, ports, server, seeded data, permissions, OAuth, MCP auth and CLI logins. Prints no secrets. |
| `yarn demo:reset` | Restores the demo services and approvals, revokes grants, starts a new run. |
| `yarn demo:replay [--mode gated\|ungated-lab]` | Scripted MCP replay as Alice (chapters 1 and 2). |
| `yarn demo:replay:agent` | Scripted chapter 3: Alice issues a grant, the agent works the task with its own login. |
| `yarn demo:replay:direct` | Calls the protected action on payments-api directly, skipping the ticket. |
| `yarn demo:grant [--targets a,b] [--ttl 15] [--revoke id] [--check]` | Alice issues, revokes or checks a task grant with her own token. |
| `yarn demo:findings [--revocation]` | Measures scopes, grant types, token audience and lifetime, service principals and executor restrictions on the running server. |
| `yarn demo:verify [runId]` | Catalog read-back plus every decision of a run. |
| `yarn demo:export [runId\|latest]` | Writes a run's sanitized events to `evidence/`. |
| `yarn demo:test` | Type check, unit tests and the end-to-end suite for the running profile. |
| `yarn demo:dashboard-smoke` | Browser test: runs all chapters on the dashboard and checks every result. |
| `yarn demo:rehearse` | Timed scripted run of both profiles. |

Runtime output (logs, run exports, measurements, screenshots) goes to `.demo/` and
`evidence/`, both gitignored.

## Troubleshooting

- `Port 8055 is already in use` during login: a stale CLI callback, `fuser -k 8055/tcp`.
- `No usable token for CLI instance`: `yarn demo:login <user>`.
- Chapter 1 says "Needs the lab server": `yarn demo:stop && yarn demo:start:ungated`.
- The page asks to sign in after a reload: sign in again (the Dex container was restarted).
