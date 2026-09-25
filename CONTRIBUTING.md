# Contributing

## Setup

```sh
bun install
```

## Workflow

```sh
bun run typecheck   # tsc --noEmit against the real @oh-my-pi/pi-coding-agent types
bun test             # fixture-based unit tests, no mocking of the module under test
```

Both must pass before a PR. There is no build step: the extension ships as plain `.ts`, loaded
directly by omp's extension loader (`-e path/to/src/index.ts`, or via `omp.extensions` in
`package.json` once installed).

## Code shape

- `src/parse.ts` — the only module allowed to touch `unknown` (raw config, YAML frontmatter, JSON
  manifests). Everything else consumes named types.
- `src/tiers.ts` — pure model-id → tier classification. No I/O.
- `src/config.ts` — merges `agentRoleRouter` layers into one `RouterConfig`. No I/O.
- `src/agents.ts` — the only module that touches the filesystem or calls omp's `discoverAgents`.
- `src/router.ts` — the pure routing decision (`SpawnFacts` + `RouterConfig` → `Decision`). No I/O,
  no omp SDK import — this is what most tests exercise directly.
- `src/index.ts` — wires the above to the `before_subagent_spawn` hook.

Keep that boundary: if a new test needs to mock the filesystem or `discoverAgents`, it almost
certainly belongs against `router.ts`'s pure `decide()` instead, with a stub `DefinitionLookup`.

## Tests

Fixture-based, not mock-based — real `.md`/`.json` files under `test/fixtures/`, real
`node:fs/promises`. The one exception is `test/index.test.ts`, which stubs the minimal slice of
`ExtensionAPI`/`ExtensionContext` this extension actually calls (cast through `unknown`, not `any`)
so the hook wiring itself is exercised without a live omp process.

A new tier, model id, or config shape needs a fixture + assertion, not a mock of
`classifyDeclaredModel`/`parseConfigLayer` themselves.

## Verifying against real omp

Unit tests cover the code in this repo; they cannot prove what omp itself does with a returned
`{ model, note }`. Changes near `src/index.ts`'s hook contract should be re-verified against a real
`omp -p -e src/index.ts "…"` probe — see the README's "Verified with omp 18.3.x" section for the
method — before merging.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). One logical change per commit.
