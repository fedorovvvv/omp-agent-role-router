# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - 2026-09-26

### Added

- `before_subagent_spawn` extension that classifies a spawned agent's declared model tier (Claude
  Code `opus`/`sonnet`/`haiku` vocabulary, OpenAI/Codex `gpt-*` vocabulary) and routes it to an omp
  model role (`@default`/`@task`/`@smol`/…) instead of letting it silently inherit the parent
  session's live model.
- Zero-config defaults: `opus → @default`, `sonnet → @task`, `haiku → @smol`, plus a Codex/OpenAI
  tier map.
- `agentRoleRouter` config block (user `config.yml` and/or project `.omp/config.yml`) for the
  tier→role map, per-agent overrides, and per-plugin overrides, with project-over-user merge.
- Cached agent-definition lookup (`src/agents.ts`) keyed on the mtimes of the same registries and
  agent directories omp's own discovery reads, so a spawn with no filesystem change never rescans.
- Full precedence-respecting passthrough: an explicit per-call model, a `task.agentModelOverrides`
  entry, an already-resolved `modelRole`, or a definition whose own `model:` omp already honours,
  are never touched.
- 97 `bun test` cases across tier classification, config parsing/merging, agent-definition caching,
  the routing decision, and end-to-end extension wiring.

[0.1.0]: https://github.com/fedorovvvv/omp-agent-role-router/releases/tag/v0.1.0
