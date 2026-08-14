# hetzner-mcp

An MCP server for Hetzner. Cloud projects, account resources and dedicated
servers from one connection, with the whole REST API reachable — not just the
parts somebody wrapped in a tool.

```bash
npx @donedynamics/hetzner-mcp install
```

## What it is

Hetzner's APIs have 221 operations. Publishing 221 tools would spend the host's
context budget on schemas it never calls, so this server publishes **thirteen**:
the loop an operator actually repeats, plus a searchable catalog that reaches
everything else.

It is built for people running more than one thing. A Hetzner Cloud token is
created inside a project and cannot see any other project — there is no project
parameter anywhere in the API — so ten projects across three accounts are simply
ten connections, and every tool takes the connection by name.

## Quick start

The shortest working setup is one environment variable:

```bash
export HETZNER_TOKEN=<your Hetzner Cloud API token>
npx @donedynamics/hetzner-mcp install
```

`install` detects the MCP clients on your machine — Claude Code, Claude Desktop,
Codex, Cursor, Zed, opencode, Kimi, MiniMax — shows you exactly what it will
write, and writes only what you approve. It writes a **pointer**: a command and
at most a connection name. It never writes a credential into a client config.

```bash
npx @donedynamics/hetzner-mcp install --dry-run   # show the diff, change nothing
npx @donedynamics/hetzner-mcp install --pin       # pin the exact version
npx @donedynamics/hetzner-mcp doctor              # what is configured, and what is wrong with it
```

## Several projects, several accounts

Put the name in the variable and you have a second connection:

```bash
export HETZNER_TOKEN_PROD=...        # connection "prod"
export HETZNER_TOKEN_STAGING=...     # connection "staging"
export HETZNER_ACCOUNT_TOKEN=...     # connection "account"  (Storage Boxes)
```

Every tool then takes `connection: "prod"`, and `find_resources` takes
`connection: "*"` to search all of them at once. With exactly one connection
configured, the parameter does not exist at all — there is nothing to choose.

For per-connection settings — a read-only production connection, a credential
from 1Password, a longer timeout — use a config file. Full reference:
**[docs/connections.md](docs/connections.md)**.

```jsonc
{
  "version": 1,
  "defaultConnection": "prod",
  "connections": {
    "prod": { "tokenEnv": "HZ_PROD", "readOnly": true },
    "prod-write": { "tokenCommand": ["op", "read", "op://Infra/hcloud/credential"] },
    "storage": { "surface": "hetzner", "tokenEnv": "HZ_ACCOUNT" }
  }
}
```

**Credentials cannot go in that file.** The schema has no `token` property and
rejects unknown keys, so writing one is a startup error that tells you the three
places it can live instead.

## Three surfaces

Hetzner is not one API, and this server does not pretend otherwise:

| Surface             | Address                   | A credential covers                                                                |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `cloud` _(default)_ | `api.hetzner.cloud/v1`    | one Cloud **project** — servers, volumes, networks, firewalls, load balancers, DNS |
| `hetzner`           | `api.hetzner.com/v1`      | the **account** — Storage Boxes                                                    |
| `robot`             | `robot-ws.your-server.de` | the **account** — dedicated servers _(planned, v0.3)_                              |

The surface is always visible, because a cloud `server` is a virtual machine
billed by the hour and a robot `server` is leased physical hardware on a monthly
contract with a cancellation period. Merging those two into one word is how
"reboot the server" becomes a question nobody can answer safely.

You never configure an address. Hetzner runs exactly one instance of each API,
so it is derived from the surface — a value you could type there could only
repeat what the server already knows, or be wrong.

## The tools

| Tool                                                                                              | What it does                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `find_resources`                                                                                  | Find resources by name, by **label selector**, or by listing a type — across one connection or all of them                         |
| `get_resource`                                                                                    | The full stored configuration of one resource                                                                                      |
| `get_action`                                                                                      | Read an Action, optionally waiting for it to finish, or list a resource's recent Actions                                           |
| `get_metrics`                                                                                     | CPU, disk and network for a server; connections, requests and bandwidth for a load balancer                                        |
| `get_pricing`                                                                                     | What Hetzner publishes, with the currency and the VAT rate                                                                         |
| `create_server`                                                                                   | Provision a server _(billable — see below)_                                                                                        |
| `control_resource`                                                                                | Power and boot control, rescue mode, ISO and network attachment, volume attach/detach/resize, IP assignment, load balancer targets |
| `manage_dns`                                                                                      | Zones and record sets                                                                                                              |
| `set_labels`                                                                                      | Set labels — which is what makes `find_resources` powerful                                                                         |
| `search_operations` → `describe_operation` → `execute_read_operation` / `execute_write_operation` | Everything else in the API, all 221 operations                                                                                     |
| `execute_destructive_operation`                                                                   | Deletes, rebuilds and overwrites — **registered only when explicitly enabled**                                                     |

### Most of this API is asynchronous

144 of Hetzner's 221 operations return an **Action** rather than a result: the
call returns `{action: {status: "running"}}` and the work happens afterwards. So
waiting is the default here rather than a convenience, and every response says
in `meta.action.awaited` whether the work actually finished or the wait gave up.
A tool that reported a running Action as done would be worse than one that never
waited, because you could not tell.

## Safety

**Deletes are off by default.** `execute_destructive_operation` is not
registered unless `HETZNER_ALLOW_DESTRUCTIVE=true` — not listed-and-refusing,
absent. Nothing in `tools/list` then carries `destructiveHint: true`, so a host
that auto-approves non-destructive tools is auto-approving something genuinely
non-destructive.

Four operations are destructive without being deletes, and the build fails if
any of them stops matching: rebuilding a server, importing a zone file,
replacing a record set, and rolling a Storage Box back to a snapshot.

**Read-only is a ceiling.** `HETZNER_READ_ONLY=true`, or `readOnly` on one
connection, refuses every non-GET at the HTTP client before the socket opens. A
connection cannot opt back out of it.

**No tool schema can name a host.** There is no `baseUrl`, `url`, `host` or
credential parameter anywhere. `connection` is an enum over the names you
configured. An injected instruction to point at another server has nowhere to
land.

### One thing to know before you use writes

**Operations that open a bill are not gated.** With a write-capable connection,
provisioning a server is reachable without any additional flag. The server makes
the cost visible rather than absent — `search_operations` marks those operations
`costly`, and a call that created something reports Hetzner's published price in
`meta.billing`.

That is a real mitigation for a model reasoning in good faith and **not** a
mitigation against prompt injection. If it is the wrong trade for you, use a
read-only Hetzner token, or `readOnly: true`, and keep writes on a separate
connection you name explicitly.

The full threat model is in **[SECURITY.md](SECURITY.md)**, including the parts
where the news is not good.

## Environment reference

| Variable                                                      | Effect                              |
| ------------------------------------------------------------- | ----------------------------------- |
| `HETZNER_TOKEN[_<NAME>]`                                      | A Cloud connection                  |
| `HETZNER_ACCOUNT_TOKEN[_<NAME>]`                              | An account-API connection           |
| `HETZNER_ROBOT_USER_<NAME>` + `HETZNER_ROBOT_PASSWORD_<NAME>` | A Robot connection                  |
| `HETZNER_CONNECTION`                                          | Which connection reads default to   |
| `HETZNER_ALLOW_DESTRUCTIVE`                                   | Register the destructive door       |
| `HETZNER_READ_ONLY`                                           | Refuse every write, server-wide     |
| `HETZNER_MCP_CONFIG`                                          | Path to a config file               |
| `HETZNER_LOG_LEVEL`                                           | `error` · `warn` · `info` · `debug` |

## Documentation

- **[docs/connections.md](docs/connections.md)** — connections, credentials, precedence
- **[SECURITY.md](SECURITY.md)** — threat model and recommended posture
- **[docs/clients/](docs/clients/)** — per-client installation notes
- **[CHANGELOG.md](CHANGELOG.md)**

## Development

```bash
npm install
npm test          # 1238 tests
npm run typecheck
npm run codegen   # regenerate the catalog from the vendored OpenAPI specs
npm run build
```

The catalog is generated from Hetzner's own OpenAPI specifications, which are
vendored into `scripts/` and committed. Every MCP client spawns this process
fresh, so parsing 3.4 MB of spec on each start — or fetching it — would be worse
than a file in git. CI regenerates and diffs, so an upstream change breaks the
build loudly instead of shipping a stale tool surface.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
