# Connections

A connection is **one surface and one credential**. Everything else in this
document follows from that sentence.

## Why it is shaped this way

A Hetzner Cloud API token is created inside a project and cannot see any other
project. There is no project parameter anywhere in the API. So a second project
is a second token, and a second token is a second connection.

That is not a limitation this server works around — it is the shape of the
thing, and the configuration mirrors it. Ten projects across three Hetzner
accounts are ten connections. No account concept, no project concept, no
switching.

## Surfaces

Hetzner is not one API. Which one a connection talks to is its **surface**:

| Surface   | Address                   | Auth         | A credential covers                 |
| --------- | ------------------------- | ------------ | ----------------------------------- |
| `cloud`   | `api.hetzner.cloud/v1`    | Bearer token | one Cloud **project**               |
| `hetzner` | `api.hetzner.com/v1`      | Bearer token | the **account** (Storage Boxes)     |
| `robot`   | `robot-ws.your-server.de` | HTTP Basic   | the **account** (dedicated servers) |

`cloud` is the default and covers the overwhelming majority of use, including
DNS — zones and records live in the Cloud API.

The surface is never inferred and never hidden, because a cloud `server` is a
virtual machine billed by the hour and a robot `server` is leased physical
hardware with a cancellation notice period. Those must not share a name.

**There is no `baseUrl` setting.** Hetzner runs exactly one instance of each
API, so the address is derived from the surface. A value you could type there
could only repeat what the server already knows, or be wrong.

## The short way: environment variables only

No file. One variable is a working setup:

```bash
export HETZNER_TOKEN=<your Cloud project token>
```

That is a connection named `default` on the `cloud` surface.

For several, put the name in the variable:

```bash
export HETZNER_TOKEN_PROD=...        # connection "prod",    cloud
export HETZNER_TOKEN_STAGING=...     # connection "staging", cloud
export HETZNER_ACCOUNT_TOKEN=...     # connection "account", hetzner
export HETZNER_ROBOT_USER_METAL=...  # connection "metal",   robot
export HETZNER_ROBOT_PASSWORD_METAL=...
```

The full mapping:

| Variable                                                      | Connection | Surface   |
| ------------------------------------------------------------- | ---------- | --------- |
| `HETZNER_TOKEN`                                               | `default`  | `cloud`   |
| `HETZNER_TOKEN_<NAME>`                                        | `<name>`   | `cloud`   |
| `HETZNER_ACCOUNT_TOKEN`                                       | `account`  | `hetzner` |
| `HETZNER_ACCOUNT_TOKEN_<NAME>`                                | `<name>`   | `hetzner` |
| `HETZNER_ROBOT_USER` + `HETZNER_ROBOT_PASSWORD`               | `robot`    | `robot`   |
| `HETZNER_ROBOT_USER_<NAME>` + `HETZNER_ROBOT_PASSWORD_<NAME>` | `<name>`   | `robot`   |

`<NAME>` becomes the connection name lowercased with `_` read as `-`, so
`HETZNER_TOKEN_ACME_OPS` defines the connection `acme-ops`.

### Why the surface is in the variable's name

It could have been a separate `HETZNER_SURFACE_<NAME>` variable. It is not,
because a separate variable can be forgotten — and a forgotten surface means
silently talking to the wrong API with a credential that will not work there.
In this scheme "the variable exists" and "the surface is known" are the same
fact, so the incomplete state cannot be expressed.

Two mistakes the scheme makes possible are caught at startup, by name:

- `HETZNER_TOKEN_PROD` and `HETZNER_ACCOUNT_TOKEN_PROD` both claim `prod`.
  One of them has to be renamed, and the error says which two variables collided.
- `HETZNER_ROBOT_USER_METAL` without `HETZNER_ROBOT_PASSWORD_METAL`. Basic auth
  needs both halves, and the error names the missing one.

## The longer way: a registry file

Reach for a file when you want per-connection settings — a read-only production
connection, a longer timeout, a credential from a password manager.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/devrim-1283/hetzner-mcp/main/schema/config.v1.json",
  "version": 1,
  "defaultConnection": "prod",
  "connections": {
    "prod": {
      "surface": "cloud",
      "tokenEnv": "HZ_PROD",
      "readOnly": true
    },
    "staging": {
      "tokenCommand": ["op", "read", "op://Infra/hcloud-staging/credential"]
    },
    "storage": {
      "surface": "hetzner",
      "tokenEnv": "HZ_ACCOUNT"
    },
    "metal": {
      "surface": "robot",
      "userEnv": "RB_USER",
      "passwordEnv": "RB_PASS"
    }
  }
}
```

`surface` defaults to `cloud`, which is why `staging` does not name one.

### Where the file is looked for

1. `$HETZNER_MCP_CONFIG`
2. `./.hetzner-mcp.json`
3. `~/.config/hetzner-mcp/config.json` — on Windows, `%APPDATA%\hetzner-mcp\config.json`

**The first one found is the configuration.** Nothing is merged across
locations. Merging is where configuration systems stop being explainable —
"which of these files set `readOnly`?" is a question with no good answer, so it
is never created.

Environment variables and the file are combined. If a name is defined in both,
the environment wins **whole** — not field by field, because a half-file,
half-environment connection is not something anyone can hold in their head.
`hetzner-mcp doctor` reports which names were shadowed.

## Credentials are never stored in this file

The schema has no `token`, `password` or `user` property, and unknown properties
are rejected. Writing a credential into the file is a startup error, not a
discouraged habit.

Point at the credential instead:

| Field                         | Surfaces           | Meaning                                           |
| ----------------------------- | ------------------ | ------------------------------------------------- |
| `tokenEnv`                    | `cloud`, `hetzner` | read this environment variable                    |
| `tokenCommand`                | `cloud`, `hetzner` | run this argv and read stdout                     |
| `tokenKeychain`               | `cloud`, `hetzner` | read the OS keychain                              |
| `userEnv` + `passwordEnv`     | `robot`            | two environment variables                         |
| `userEnv` + `passwordCommand` | `robot`            | a variable and an argv                            |
| `credentialKeychain`          | `robot`            | keychain item whose **account is the Robot user** |

At most one source per connection. Two sources means two answers to "where is
the credential" and no rule for which wins.

If you name none, the conventional variable for that connection is read —
`HETZNER_TOKEN_<NAME>` and so on, exactly as above.

`tokenCommand` is an argv array handed straight to the process, never to a
shell. There is no interpolation, no globbing and no word splitting, so a
config file cannot become a way to run arbitrary commands. The helper also runs
with every `HETZNER_*` credential variable removed from its environment: a
program whose job is to fetch a credential has no business receiving the ones
already held.

## Per-connection settings

| Field              | Default  | Notes                                                               |
| ------------------ | -------- | ------------------------------------------------------------------- |
| `label`            | —        | Free text for `doctor` output                                       |
| `readOnly`         | `false`  | Refuses every non-GET **at the transport**, before the socket opens |
| `allowDestructive` | inherits | Can only narrow — see below                                         |
| `timeoutMs`        | `30000`  | 1 000–120 000                                                       |

Both gates are **ceilings**, and the direction is deliberate:

- `HETZNER_READ_ONLY=true` makes every connection read-only. A connection cannot
  opt back out.
- `allowDestructive: true` on a connection grants nothing unless
  `HETZNER_ALLOW_DESTRUCTIVE=true` is also set. `false` keeps one connection
  protected on a server where the flag is on.

A misconfiguration therefore fails towards _less_ access, never more.

## Choosing a connection at call time

When only one connection exists, no tool takes a `connection` parameter at all —
it is not optional, it is absent.

With several:

- `defaultConnection` in the file, or `HETZNER_CONNECTION` in the environment,
  sets the default for reads.
- Write tools require an explicit connection, so a write can never happen
  through an omitted parameter.
- `find_resources` accepts `connection: "*"` to search every connection at once.

## Checking your setup

```bash
npx @donedynamics/hetzner-mcp doctor
```

It reports every connection, its surface, where it was defined and where its
credential comes from — without printing the credential. It also finds the
mistakes above, plus tokens accidentally pasted into an MCP client config.

Add `--json` to run it fleet-wide and alert on `severity == "critical"`.
