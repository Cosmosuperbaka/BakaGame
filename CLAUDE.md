# CLAUDE.md

This repository uses `AGENTS.md` as the single source of truth for coding-agent guidance.
Before changing anything, read the following files in order:

1. `AGENTS.md` — current architecture, commands, behavior, and test guidance.
2. `Agents/Spec.md` — engineering constraints and Git rules.
3. `Agents/Design.md` — required for client UI changes.
4. `Agents/Animation.md` — required for animation or interaction changes.
5. `Agents/Deployment.md` — required for deployment or infrastructure changes.
6. `Agents/Testing.md` — required for test or verification changes.
7. `Agents/Commitment.md` — required before commits or releases.

Do not duplicate project architecture or workflow details in this file. Update the authoritative
document instead so different coding tools cannot drift onto conflicting instructions.
