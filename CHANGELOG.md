# Changelog

Notable changes to MergeWright. Versions follow [semantic versioning](https://semver.org); while
the version is 0.x, a minor release may change behaviour.

## 0.1.0

The first public release.

- The flow engine: a card is briefed, implemented in its own worktree, gated, reviewed by a model
  from another vendor, adjudicated, squash-merged and reflected on, with stop points for risky
  cards, scope checks, remediation rounds and crash-safe resume.
- Conventions and schemas for specs, cards, roles, flows, gates, MCP servers and memory;
  `mw check` and `mw trace`.
- Unattended work with `mw work`, including a systemd unit.
- Harnesses for Claude Code, Codex, an OpenAI-compatible local endpoint, shell and mock.
- Two machines sharing one project through a git hub, with a lease.
- Four interfaces over one set of operations: the `mw` command, a terminal UI (`mw tui`), a
  browser GUI (`mw ui`) and an MCP server (`mw mcp serve`).
- Packages (`mw add`, `mw remove`, `mw packages`) with an experimental API, and seven official
  packages: `mem0`, `letta`, `open-notebook`, `notebook-opennotelm`, `cline-kanban`, `board-4ga`
  and `hermes`.
- Single executables for Linux x64, Linux arm64 and Apple-silicon macOS, with checksums and an
  installer that verifies them.
