/**
 * Regression cover for doctor reading the package spec out of a client config.
 *
 * The package publishes under `@donedynamics/hetzner-mcp` while the command it
 * installs is `hetzner-mcp`, so the package name and the program name are two
 * different strings and a config file can carry either spelling.
 *
 * Doctor reads the spec back out of every client config to answer one question:
 * do the clients on this machine agree on which version to run? An extractor
 * written as `word === 'hetzner-mcp' || word.startsWith('hetzner-mcp@')` matches
 * neither scoped form, and it would fail silently — every test still green,
 * because nothing else asserts on the extraction.
 *
 * The case that matters most is the mixed one. A machine configured by two
 * different tools, or before and after a rename, holds one entry of each
 * spelling, and that is precisely the drift doctor exists to report.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../../src/install/doctor.js';

const created: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hetzner-mcp-spec-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a Claude Code user config whose hetzner entry carries `spec`. */
async function scanWithSpec(spec: string) {
  const home = sandbox();
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          hetzner: { command: 'npx', args: ['-y', spec], env: {} },
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  // An empty cwd keeps project-scope adapters from finding this repo's own files.
  return runDoctor({
    homeDir: home,
    cwd: sandbox(),
    env: {},
    packageVersion: '1.4.2',
    packageName: '@donedynamics/hetzner-mcp',
  });
}

function hetznerClients(report: Awaited<ReturnType<typeof scanWithSpec>>) {
  return report.clients.filter((client) => client.packageSpec !== undefined);
}

describe('reading the installed spec back out of a config', () => {
  it.each([
    ['the scoped name it publishes under', '@donedynamics/hetzner-mcp@latest'],
    ['a pinned scoped version', '@donedynamics/hetzner-mcp@1.4.2'],
    ['the unscoped name', 'hetzner-mcp@latest'],
    ['an unscoped pin', 'hetzner-mcp@0.9.0'],
    ['a bare name with no version at all', 'hetzner-mcp'],
  ])('recognises %s', async (_why, spec) => {
    const report = await scanWithSpec(spec);

    expect(hetznerClients(report).map((client) => client.packageSpec)).toContain(spec);
  });

  it('does not claim an unrelated package as its own', async () => {
    // A neighbouring name that differs only by punctuation. An extractor loose
    // enough to swallow it would report version drift between two projects.
    const report = await scanWithSpec('hetznermcp@2.0.1');

    expect(hetznerClients(report).map((client) => client.packageSpec)).not.toContain(
      'hetznermcp@2.0.1',
    );
  });
});
