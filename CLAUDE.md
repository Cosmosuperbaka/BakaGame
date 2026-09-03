# CLAUDE.md

This repository uses `AGENTS.md` as the single source of truth for coding-agent guidance.
Before changing anything, read the following files in order:

1. `AGENTS.md` — overall guidance entry point and workspace overview.
2. `Agents/Conventions.md` — workspace structure, commands, environment variables, and naming conventions.
3. `Agents/Spec.md` — engineering constraints and third-party ecosystem standards.
4. `Agents/Commitment.md` — immediate atomic commit rules, versioning, and changelog specifications.
5. `Agents/WhoIsFaker.md` — WhoIsFaker domain architecture, game state machine, and protocol rules.
6. `Agents/Design.md` — required for client UI changes.
7. `Agents/Animation.md` — required for animation or interaction changes.
8. `Agents/Deployment.md` — required for deployment or infrastructure changes.
9. `Agents/Testing.md` — required for test or verification changes.
10. `Agents/NeteaseMusicApi.md` — required for Songuessr music API integration.

Do not duplicate project architecture or workflow details in this file. Update the authoritative
document instead so different coding tools cannot drift onto conflicting instructions.
