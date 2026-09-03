# AGENTS.md

This repository maintains modular, single-source-of-truth guidance documents in the `Agents/` directory.
All coding agents (Codex, Antigravity, Claude, etc.) must follow this reading order and structural map before modifying or testing code:

## Reading Order & Documentation Index

Before changing anything in this repository, locate and read the relevant authoritative documents in order:

1. **[`Agents/Conventions.md`](Agents/Conventions.md)** — **Workspace & Conventions**: Package structure (Bun `Server/`, Vite/Node `Client/`), runtime ports, dev/test/build commands, `@bakagame/shared` dual-mapping, naming conventions, and environment variables.
2. **[`Agents/Spec.md`](Agents/Spec.md)** — **Engineering Constraints**: Anti-reinventing-the-wheel & third-party ecosystem replacement standards, clean architecture rules, no-legacy-retention policy, and realtime bandwidth budgets.
3. **[`Agents/Commitment.md`](Agents/Commitment.md)** — **Commitment & Versioning**: Immediate atomic commit timing ("commit immediately per point, do not accumulate"), SemVer 2.0 versioning, Angular commit formats, and user-facing changelog syntax and tone constraints.
4. **[`Agents/WhoIsFaker.md`](Agents/WhoIsFaker.md)** — **WhoIsFaker Domain Architecture**: Typed envelope protocol, dual snapshot model, disconnect handling, complete 9-phase state machine, supplement speeches, blank player guessing & adjudication, and test mode (`Oblivionis`).
5. **[`Agents/NeteaseMusicApi.md`](Agents/NeteaseMusicApi.md)** — **Songuessr & Music Provider**: Netease cloud music API proxy, rate limits, caching, and credential isolation.
6. **[`Agents/Design.md`](Agents/Design.md)** — **Frontend Visual & Layout Specs**: Vintage-paper theme, Tailwind v4 semantic variables, three-section topbar, desktop/mobile history overlay matrix, and component usage.
7. **[`Agents/Animation.md`](Agents/Animation.md)** — **Motion & Interaction**: Framer-motion tokens (`@/lib/Motion`), spring physics, origin-anchored transitions, and spatial causality rules.
8. **[`Agents/Deployment.md`](Agents/Deployment.md)** — **Production & Edge Gateway**: Reverse proxy boundaries, TLS termination, WebSocket quotas, and port isolation.
9. **[`Agents/Testing.md`](Agents/Testing.md)** — **Testing & Verification Matrix**: `bun:test` backend suites, Vitest frontend suites, Playwright E2E workflows, and CI verification pipelines.

## Critical Workspace Rules

- **Independent Packages**: Never assume a root `package.json`. Server runs on Bun (`cd Server && bun test`), Client runs on Node/npm (`cd Client && npm test`).
- **Shared Module Single Truth**: `Server/src/shared/` is the only physical source for shared models and protocols. Never reintroduce `file:../packages/` symlink dependencies.
- **Commit Immediately**: Commit immediately after finishing each atomic modification point. Never wait until all changes are finished.
- **Do Not Duplicate**: Do not duplicate domain logic or architecture details into this root file. Update the specialized documents in `Agents/` instead so all agents stay strictly aligned.
