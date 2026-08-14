# Claude Code

|                      |                                                                            |
| -------------------- | -------------------------------------------------------------------------- |
| Adapter ids          | `claude-code-user`, `claude-code-project`                                  |
| `--client` selectors | `claude-code`, `claudecode`, `claude-code-user`, `claude-code-project`     |
| User config          | `~/.claude.json` (Windows: `%USERPROFILE%\.claude.json`)                   |
| Project config       | `<projectRoot>/.mcp.json`                                                  |
| Key path             | `mcpServers.hetzner`                                                       |
| Format               | JSON                                                                       |
| Transports written   | `stdio` only                                                               |
| Confidence           | **verified** — both paths and the reference syntax are documented upstream |
| Native CLI           | `claude mcp add-json`, preferred when the `claude` binary is on PATH       |

Claude Code is the one client where the canonical entry needs no rewriting at
all: it expands `${VAR}` and `${VAR:-default}` inside `command`, `args`, `env`,
`url` and `headers`.

## Install

```bash
npx @donedynamics/hetzner-mcp install --client claude-code                  # both scopes, filtered by detection
npx @donedynamics/hetzner-mcp install --client claude-code --scope user     # ~/.claude.json only
npx @donedynamics/hetzner-mcp install --client claude-code --scope project  # <projectRoot>/.mcp.json only
```

## What the installer writes

```json
{
  "mcpServers": {
    "hetzner": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@donedynamics/hetzner-mcp@latest",
        "hetzner-mcp-server"
      ],
      "env": {}
    }
  }
}
```

With `--connection prod`, `env` becomes `{"HETZNER_CONNECTION": "prod"}`. With
`--pin=1.4.2`, `args` becomes `["-y", "@donedynamics/hetzner-mcp@1.4.2"]`.

`"type": "stdio"` is redundant — stdio is the default whenever `command` is
present — but it is emitted anyway so that the file writer produces output
identical to `claude mcp add-json`. That is what keeps the native-CLI path and
the file-writer path idempotent with each other.

### Via the native CLI

When `claude` is on PATH the installer shells out instead of writing the file,
because the client's own CLI preserves invariants we do not know about. The exact
invocation is:

```bash
claude mcp add-json hetzner '{"type":"stdio","command":"npx","args":["-y","-p","@donedynamics/hetzner-mcp@latest","hetzner-mcp-server"],"env":{}}' --scope user
```

Use `--no-native-cli` to force the file writer.

The project-scope form passes `--scope project`, and the installer runs it with
the working directory set to the project root, because `claude` resolves
`.mcp.json` relative to the cwd.

## Supplying credentials

The installer never writes a credential. Two options, in order of preference:

**1. Export in your shell.** Claude Code inherits the environment of the shell it
was started from.

```bash
# ~/.zshrc or ~/.bashrc
export HETZNER_TOKEN='xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
```

**2. Reference the variables from the entry.** Claude Code expands `${VAR}`, so
you can make the dependency explicit — the _reference_ goes in the file, never
the value:

```json
{
  "mcpServers": {
    "hetzner": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "@donedynamics/hetzner-mcp@latest",
        "hetzner-mcp-server"
      ],
      "env": {
        "HETZNER_TOKEN": "${HETZNER_TOKEN}"
      }
    }
  }
}
```

> This second block is **not** what the installer writes. It is a hand edit you
> may make afterwards.

For several projects, accounts or surfaces, define a
[registry file](../connections.md#layer-2--a-registry-file) and select one with
`--connection`, which puts only the connection _name_ in the config.

## Verify

```bash
npx @donedynamics/hetzner-mcp doctor   # the CLIENTS section reports whether the entry was found and parses
```

Then, inside Claude Code, `/mcp` should list `hetzner`, and asking it to "list
Hetzner resources" should call `find_resources`.

If the server does not start:

- `~/.claude.json` is also Claude Code's own project-state file and can be
  hundreds of kilobytes. The installer merges through a writer that touches only
  `mcpServers.hetzner`; if you edit it by hand, keep the rest intact.
- A `${HETZNER_TOKEN}` reference resolving to an empty string produces a 401
  that looks like a bad token. `npx @donedynamics/hetzner-mcp connections` reports whether the
  source actually resolves.

## Uninstall

```bash
npx @donedynamics/hetzner-mcp uninstall --client claude-code
```

Removes `mcpServers.hetzner` and nothing else. An entry that has been hand-edited
since installation is left alone and reported, unless you pass `--force`.

## Confirmed vs unconfirmed

| Item                                                        | Status    |
| ----------------------------------------------------------- | --------- |
| `~/.claude.json` user path                                  | confirmed |
| `<projectRoot>/.mcp.json` project path                      | confirmed |
| `mcpServers` key                                            | confirmed |
| `${VAR}` / `${VAR:-default}` expansion                      | confirmed |
| `claude mcp add-json … --scope user\|project` argument form | confirmed |
