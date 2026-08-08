# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mandatory: `/Agents` specifications

**Before any work in this repository, read the specs in `Agents/` and follow them. They override default behavior.**

| File | Scope | Must read before |
|---|---|---|
| `Agents/Spec.md` | Engineering constraints, framework usage, Git commit rules | Any change |
| `Agents/Design.md` | Frontend design system, theme, layout, interaction rules | Any `Client/` change |
| `Agents/Animation.md` | Motion choreography rules, motion tokens, 100% coverage requirement | Any animation or interactive component change |
| `Agents/versioning.md` | Version numbering + commit message format | Any commit or release |

Non-negotiable rules distilled from those documents:

- **Production quality only.** No demo/placeholder text, no design-style or theme names in UI copy or code comments.
- **Framework-native first.** Prefer Elysia / React / Tailwind / Radix native capabilities over new dependencies or custom abstractions.
- **Theme is global.** All styling derives from the semantic variables in `Client/src/index.css`. Never hardcode colors, radii, shadows, or fonts in business components.
- **Atomic commits.** One self-contained change per commit, verified before committing.
- **Commit message format:** `type(Game): 中文正文` — body in Chinese, **≤ 12 Chinese characters**; split the commit if longer. Game scope is `Faker` / `Song` / `CCB` / `Core`.
- **Version format:** `V1.x.x` — minor for large features, patch per bug-fix cycle.
- When user instructions conflict with these documents, the newest explicit user instruction wins, and the affected spec file must be updated in the same session.

## Project

BakaGame (server name: WhoIsFaker) is a real-time multiplayer party game — a digital "谁是卧底" (Who is the Undercover). All game state lives on the server and is pushed to clients over WebSocket. There is no REST API for game actions.

## Workspace Structure

Two independent packages — **no root-level package.json or shared scripts**:

| Package | Runtime | Location |
|---|---|---|
| `WhoIsFaker_Server` | Bun | `Server/` |
| `whoisfaker-client` | Node / npm | `Client/` |

**Shared definitions live in `Server/src/shared/`** (`model.ts` + `protocol.ts`), the single copy used by both sides. There is no `@bakagame/shared` npm package and no `packages/` directory — the server is deployed by mounting only `Server/` as the app root, so anything it imports must sit inside that directory.

- Server imports it by relative path (`../shared`), re-exported through `Server/src/domain/model.ts`.
- Client keeps the `@bakagame/shared` specifier, mapped in **two** places that must stay in sync: `Client/tsconfig.app.json` `paths` (for `tsc`) and `Client/vite.config.ts` `resolve.alias` (for the bundler). Vite does not read tsconfig paths, so editing only one silently breaks the build.

Never reintroduce a `file:../packages/...` dependency: npm/bun turn it into a symlink to an absolute host path, which dangles on the deploy target (`ENOENT reading .../node_modules/@bakagame/shared`).

## Commands

### Server (`cd Server`)
```bash
bun run dev          # watch mode
bun run start        # production
bun run check        # tsc --noEmit
bun test             # run all tests
bun test --coverage
bun run docs:openapi # export Agents/http-openapi.json
```
Default port: `4850`. Requires Bun — uses `Bun.env`, `Bun.sleep`, `bun:test`.

### Client (`cd Client`)
```bash
npm run dev          # Vite dev server → http://localhost:5173
npm run build        # tsc -b && vite build
npm run lint         # eslint .
npm run preview
```

Shared definitions have no package of their own; the server's `bun run check` and the client build type-check them in place.

## Environment Variables

`Server/.env` (see `.env.example`):
```
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:4850
SERVER_PORT=4850
```

`Client/.env` (see `.env.example`):
```
VITE_SERVER_URL=http://localhost:4850
```

## Architecture

### Communication Protocol

All WebSocket messages use a typed envelope defined in `Server/src/shared/protocol.ts`:

- **Client → Server**: `{ id, type, roomId?, sessionToken?, payload }`
- **Server → Client**: one of three shapes:
  - `AckPacket` — response to a command: `{ type:"ack", id, requestType, payload }`
  - `ErrorPacket` — error: `{ type:"error", id, error: { code, message, details } }`
  - `EventPacket` — server push: `{ type:"event", event, payload }`

The client WS singleton (`Client/src/lib/ws.ts`) maintains a pending-request map keyed by `id` to resolve/reject a Promise when the matching ack/error arrives.

### Server Layers

```
transport/       ← Elysia app, WS handler, request parsing, packet factories
application/     ← RoomService (routes all commands), RoomManager, ConnectionRegistry
domain/          ← rules.ts (pure functions), model.ts (re-exports shared), errors.ts
infrastructure/  ← word-bank-repository.ts, event-logger.ts
config/          ← env.ts, constants.ts, version.ts
```

`RoomService` (`Server/src/application/room-service.ts`) is the core — it holds all rooms and connections in memory and routes every incoming command. All state is **in-memory only**; no database. `runHousekeeping()` runs on a 10-second interval for idle room cleanup and questioner-reconnect timeout.

### Client State

Single Zustand store: `useGameStore` (`Client/src/stores/useGameStore.ts`). Holds public snapshot, per-player private state, session token, and all async actions. `GameContext.tsx` initialises the WS connection on mount.

Routing (React Router v7): `/` → `LandingPage`, `/whoisfaker` → lobby, `/whoisfaker/room/:roomId` → `RoomPage`. Both levels have a catch-all `*`: an unknown `/whoisfaker/…` path redirects to the lobby, anything else to the landing page — never leave a mistyped URL on a blank screen.

Room IDs are validated client-side before connecting, via `isValidRoomId` from `@bakagame/shared` (four digits, or the test-room ID case-insensitively). The server's `ensureRoomId` uses the same function — keep the rule in one place.

`RoomPage` entry order: wait for the socket → try `room.reconnect` → if no saved username, **show the name dialog and stay on the page** (a shared link must not bounce a first-time visitor to the lobby) → `room.join` → on `ROOM_NOT_FOUND`, create the room. While the dialog is open there is no snapshot, so `needsName` must be excluded from the "room closed, go back to lobby" effect.

Client path alias: `@/` → `Client/src/`.

## Key Patterns

**Dual snapshot model**: every state push sends both `room.snapshot` (public, identical for all players) and `game.privateState` (per-connection secrets). Never derive private info from the public snapshot.

**Typed errors**: `AppError` with a `code` string (e.g. `"ROOM_NOT_FOUND"`, `"INVALID_PHASE"`) is used uniformly throughout the server. The transport layer converts them to `ErrorPacket`.

**Session persistence**: session tokens are stored in cookies (keyed by `roomId`) via `Client/src/lib/cookie.ts` for reconnect after page refresh. On reconnect, the client auto-attempts `room.reconnect`.

**Code comments in Chinese**: all business-logic comments in the server are in Simplified Chinese. Match this convention when adding comments.

## Test Mode

Room ID `"Oblivionis"` (case-insensitive) is a special test room. It follows **exactly the same rules** as a normal room — it does not bypass player-count checks and there is no solo play.

- **Server**: accepts the extra commands `test.jumpToPhase`, `test.setMyRole`, `test.addBot`, `test.removeBot`. Bots are real server-side players: they occupy roles, speak, and vote. Reaching a phase still requires a legal roster, so fill the room with bots first.
- **Client**: every `TestController` action is a real command to the server; failures surface as toasts. There is no local mock data and no client-side interception.

Bots follow the same membership rules as humans: added before a round they join as players, added mid-round they can only spectate.

`test.jumpToPhase` checks the player count **before** calling `startRound`, so a rejected jump leaves the room in `waiting` rather than half-started. It also never clears an existing `questionerPlayerId` — only a jump to `wordSubmission` reassigns the questioner to the caller; every other jump keeps whoever already holds the seat.

## Game State Machine

```
waiting → assigningQuestioner → wordSubmission → description → voting
  → tieBreak (if tied) → night → daybreak → description (next round)
  → blankGuess (if blank player triggered)
  → gameOver
```

Win conditions: `good` (all undercoverers eliminated), `undercover` (outnumber civilians), `blank` (guesses both words correctly), `aborted`.

**Participant count is the basis for every role rule.** The questioner does not play, so participants = active players minus the questioner (an online spectator can take the questioner seat instead, leaving all active players in the game). Roles: `civilian`, `undercover`, `angel` (10+ participants), `blank` (8+ participants); `maxUndercoverCount = max(1, floor(participantCount / 4))`.

A round needs **4 participants plus 1 questioner**: 5 active players, or 4 active players when an online spectator hosts. `getParticipantCount` is the single source of truth — never count `players.length` directly for a role decision.

## Description Records

`DescriptionRecord.kind` has three values:

| kind | tieBreakIndex? | supplementIndex? | meaning |
|---|---|---|---|
| `"description"` | — | — | Normal round description |
| `"tieBreak"` | 1, 2, 3… | — | Tie-break speech; each tie-break event gets a new index |
| `"supplement"` | — | 1, 2, 3… | Questioner-requested extra speech; each request gets a new index |

`GameRound.tieBreakCount` tracks how many tie-break events have occurred (used to assign `tieBreakIndex`).

`RoomSnapshot.status.pendingSupplementPlayerIds` lists players who have been asked to give a supplement but haven't spoken yet.

## New Server Commands

| Command | Phase | Who | Description |
|---|---|---|---|
| `game.cancelVote` | `voting` or `tieBreak(vote)` | any voter | Remove own vote; allows re-voting |
| `game.cancelNightAction` | `night` | actor | Remove own night action |
| `game.requestSupplement` | `description` (after all spoken) | questioner | Ask specific players for extra speech; payload `{ playerIds: string[] }` |

For `game.requestSupplement`:
- Only allowed after `isDescriptionComplete` (all alive players have spoken).
- Only one supplement request can be active at a time (`round.supplement` must be undefined).
- The server tracks `round.supplement = { index, requestedPlayerIds, donePlayers }`.
- When `donePlayers.length >= requestedPlayerIds.length`, supplement is cleared automatically.
- In `handleSubmitDescription`, the supplement check runs **before** the `ALREADY_SUBMITTED` check so that players who already gave a normal description can still submit a supplement.

## Vote Undo (Client)

`privateState.myCurrentVoteTargetId` (server-pushed, in `PrivateGameState`) is the source of truth for who the current player has voted for. Do **not** store vote target in local React state. When the player cancels, call `sendCommand("game.cancelVote", {})` and the server clears their vote + re-broadcasts state.

## Blank Player UX

`BlankGuessPhase.tsx` exports two components:

- **`BlankGuessButton`** — a floating button pinned to the game area's **top-right** (`absolute right-3 top-3 z-30`, `md:right-5 md:top-5`) so it never collides with the bottom phase controller. Visible whenever `canSubmitBlankGuess && !blankGuessUsed && phase !== "gameOver"`. It is the blank player's primary action, so it uses `Button`'s `default` variant at `size="lg"` — do not hand-roll a tinted low-opacity style, which disappears against the warm paper background. Opens a modal overlay (`absolute inset-0 z-20`) for guessing both words. This is **non-blocking**: it overlays the current phase UI without replacing it.
- **`BlankGuessWaiting`** — shown to all players during the `blankGuess` phase while waiting for the blank player to guess.

`GameArea.tsx` renders `<BlankGuessButton />` inside the outermost `relative` div so overlays position correctly. The `blankGuess` case in `PhaseContent` renders `<BlankGuessWaiting />`.

## Description Display (in-phase)

`DescriptionPhase` renders the current round's speeches as a **two-column table** (player name / description), not as cards. All players due to speak this round are listed up front.

Speeches reveal **in order**: if any earlier player in `descriptionOrder` has not submitted yet, later submissions stay hidden so early speakers can't influence others by racing ahead. Exceptions — the questioner and spectators see everything; you always see your own line. Hidden cells show `PendingSpeech` (an animated ellipsis), never a dash or blank.

Speech order comes from `status.descriptionOrder` (normal), `status.tieBreakCandidateIds` (tieBreak), or `status.pendingSupplementPlayerIds` plus already-spoken players (supplement).

## Player Marking (Local Only)

Player marks (`"none" | "suspect" | "safe"`) are **pure React local state** in `PlayerList.tsx`. They are never sent to the server and reset on page reload. The mark indicator is a `w-4 h-4` dot on the left of each row; click cycles none → suspect (orange) → safe (emerald) → none.

## RoomPage Layout

**Topbar** uses `grid grid-cols-3` with three equal sections:

- **Left**: back arrow, room name, room ID chip, test badge
- **Center** (`justify-center`): day counter (`第N天`), questioner/spectator badge, and a sized placeholder that the word chip docks into

The word itself is rendered by `AssignedWord` (`Client/src/components/room/AssignedWord.tsx`) as a single `position: fixed` element that moves continuously between the game-area centre (revealed) and the topbar dock. There is no `layoutId` handoff between two elements — that was the cause of the old teleport.
- **Right** (`justify-end`): disconnect, mobile panel toggles, settings

**Aside (desktop)** is an extensible panel on the left:
- Collapsed (default): `w-64`, shows `PlayerList` only.
- Expanded: animates to full width. Speech cells are rendered **inside the player rows themselves** — each row is one flex line whose left half is the `PlayerRow` (`w-64`, `border-r`) and whose right half is the description cells. Row alignment is guaranteed by DOM structure, not by duplicating row heights on two sides. Pass the `history` prop to `PlayerList` to enable this.
- An `h-8 w-8` toggle button straddles the panel's right border (`absolute -right-4 top-1/2`), using `PanelRightOpen` / `PanelRightClose`.

Column model lives in `Client/src/lib/descriptionColumns.ts` (`buildDescriptionColumns`), shared by the sidebar and the game-over report. Columns: `第N轮` (normal), `平票N` (amber, tieBreak), `补充N` (sky, supplement).

`DescriptionTable` (from `DescriptionHistory.tsx`) is the standalone table with its own player column — used only by the game-over report, where there is no adjacent player panel.

## Tests

All tests are under `Server/test/` using `bun:test`. To run a single file:
```bash
bun test test/rules.test.ts
```

Key test files: `rules.test.ts` (pure domain logic), `room-service.test.ts` (service unit tests), `app.test.ts` (HTTP + WS integration), `protocol-openapi.test.ts` (protocol conformance).

When adding fields to `GameRound` in the shared model, update all fixture objects in `rules.test.ts` accordingly (TypeScript will error otherwise).

No frontend tests exist.
