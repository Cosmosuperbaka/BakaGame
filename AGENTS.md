# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

BakaGame (server name: WhoIsFaker) is a real-time multiplayer party game — a digital "谁是卧底" (Who is the Undercover). All game state lives on the server and is pushed to clients over WebSocket. There is no REST API for game actions.

## Workspace Structure

Two independent packages — **no root-level package.json or shared scripts**:

| Package | Runtime | Location |
|---|---|---|
| `WhoIsFaker_Server` | Bun | `Server/` |
| `whoisfaker-client` | Node / npm | `Client/` |

**Shared definitions live in `Server/src/shared/`** (`model.ts` + `protocol.ts`), the single copy used by both sides. There is no `@bakagame/shared` npm package and no `packages/` directory — the server is deployed by mounting only `Server/` as the app root, so anything it imports must sit inside that directory.

- Server imports it by relative path (`../shared/Index`), re-exported through `Server/src/domain/Model.ts`.
- Client keeps the `@bakagame/shared` specifier, mapped in **two** places that must stay in sync: `Client/tsconfig.app.json` `paths` (for `tsc`) and `Client/vite.config.ts` `resolve.alias` (for the bundler). Vite does not read tsconfig paths, so editing only one silently breaks the build.

Detailed naming, structure, and Clean Code standards are documented in `Agents/Conventions.md`.

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
npm test             # Vitest unit/integration/regression tests
npm run test:coverage
npm run test:e2e     # Playwright; starts Server + Vite automatically
npm run verify       # lint + coverage + build + E2E
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

## Production Deployment

The Bun server is deployed behind a reverse proxy or edge gateway. TLS termination, source-based
rate limits, concurrent WebSocket connection quotas, message-size limits, bandwidth limits, and
connection timeouts belong to that boundary; do not expose the Bun port directly to the internet.
See `Agents/Deployment.md` for the required controls and the division between proxy protection and
application validation.

## Architecture

### Communication Protocol

All WebSocket messages use a typed envelope defined in `Server/src/shared/Protocol.ts`:

- **Client → Server**: `{ id, type, roomId?, sessionToken?, payload }`
- **Server → Client**: one of three shapes:
  - `AckPacket` — response to a command: `{ type:"ack", id, requestType, payload }`
  - `ErrorPacket` — error: `{ type:"error", id, error: { code, message, details } }`
  - `EventPacket` — server push: `{ type:"event", event, payload }`

The client WS singletons (`Client/src/lib/WhoIsFakerWs.ts` and `Client/src/lib/SonGuessrWs.ts`) maintain pending-request maps keyed by `id` to resolve/reject Promises when matching ack/errors arrive.

### Server Layers

```
transport/       ← Elysia app, WS handler, request parsing, packet factories
application/     ← RoomService (WhoIsFaker), SonGuessrService (SonGuessr), handlers/
domain/          ← Rules.ts (pure functions), Model.ts (re-exports shared), Errors.ts
infrastructure/  ← NeteaseMusicProvider.ts, WordBankRepository.ts, EventLogger.ts
config/          ← Env.ts, Constants.ts
```

`RoomService` (`Server/src/application/RoomService.ts`) and `SonGuessrService` (`Server/src/application/SonGuessrService.ts`) are the core — holding rooms and connections in memory and routing incoming commands. All state is **in-memory only**; no database. `runHousekeeping()` runs on a 10-second interval for idle room cleanup.

### Client State

- WhoIsFaker: `useWhoIsFakerStore` (`Client/src/stores/UseWhoIsFakerStore.ts`).
- SonGuessr: `useSonGuessrStore` (`Client/src/stores/UseSonGuessrStore.ts`).
- Contexts: `WhoIsFakerContext.tsx` and `SonGuessrContext.tsx`.

Routing (React Router v7):
- `/` → `LandingPage`
- `/whoisfaker` → `WhoIsFakerPage`, `/whoisfaker/room/:roomId` → `WhoIsFakerRoomPage`
- `/songuessr` → `SonGuessrPage`, `/songuessr/room/:roomId` → `SonGuessrRoomPage`

Client path alias: `@/` → `Client/src/`.

## Key Patterns

**Dual snapshot model**: every state push sends both `room.snapshot` (public, identical for all players) and `game.privateState` (per-connection secrets). Never derive private info from the public snapshot.

**Typed errors**: `AppError` with a `code` string (e.g. `"ROOM_NOT_FOUND"`, `"INVALID_PHASE"`) is used uniformly throughout the server. The transport layer converts them to `ErrorPacket`.

**Session persistence**: session tokens are stored in the current tab's `sessionStorage` (keyed by `roomId`) via `Client/src/lib/storage.ts`; usernames alone use `localStorage`. Refreshing the same tab can reconnect, while a new tab starts without the old token. On reconnect, the client auto-attempts `room.reconnect`.

**Code comments in Chinese**: all business-logic comments in the server are in Simplified Chinese. Match this convention when adding comments.

**Disconnects pause on demand**: an offline player only blocks the round when the current phase is still waiting on *them*. `shouldQueueDisconnectForDecision` asks that question per phase — speech phases reuse `getCurrentSpeechState` (covering normal/supplement/tie-break in one place), voting checks the vote list, night checks `nightActions`, `blankGuess` only blocks for the guesser. A player who already submitted is ignored. Because they may block a *later* phase, every phase transition calls `requeuePendingDisconnects`, which re-enqueues them and re-broadcasts `game.disconnectDecisionRequested`. The questioner is exempt — they go through the reconnect deadline instead.

**Test room survives an empty room**: auto-close on "nobody online" is gated by `shouldAutoCloseWhenEmpty`, which exempts `ROOM_ID_TEST_MODE`. This gate must be applied at *all three* sites (`runHousekeeping` plus both `handlePlayerOffline` branches) — otherwise the last player refreshing the page deletes the room being debugged. On `room.closed` the client clears the stored session token and sets `roomClosedAt`, which drives the redirect back to the lobby; never infer closure from "no snapshot", since that also matches initial mount.

## Test Mode

Room ID `"Oblivionis"` (case-insensitive) is a special test room. It follows the same player-count, role, voting, and night-action rules as a normal room.

- **Server**: accepts `test.jumpToPhase`, `test.setMyRole`, `test.addBot`, and `test.removeBot`. Bots are real server-side players that occupy roles, speak, and vote.
- **Client**: every `TestController` action sends a real command to the server. There is no local mock state or command interception.
- Fill the room with bots before jumping to phases that require a legal roster. Bots added during an active round become spectators.

## Game State Machine

```
waiting → assigningQuestioner → wordSubmission → description → voting
  → tieBreak (if tied) → night → description (next round; emits a transient daybreak notice)
  → blankGuess (if blank player triggered)
  → gameOver
```

Roles: `civilian`, `undercover`, `angel` (10+ participants), `blank` (8+ participants).

Win conditions: `good` (all undercoverers eliminated), `undercover` (outnumber civilians), `blank` (guesses both words correctly), `aborted`.

A round needs at least 4 participants plus 1 questioner. Participants are active players excluding the questioner; an online spectator may serve as questioner. `maxUndercoverCount = max(1, ceil(participantCount / 4))`.

## Description Records

`DescriptionRecord.kind` has three values:

| kind | tieBreakIndex? | supplementIndex? | meaning |
|---|---|---|---|
| `"description"` | — | — | Normal round description |
| `"tieBreak"` | 1, 2, 3… | — | Tie-break speech; each tie-break event gets a new index |
| `"supplement"` | — | 1, 2, 3… | Questioner-requested extra speech; each request gets a new index |

`GameRound.tieBreakCount` tracks how many tie-break events have occurred (used to assign `tieBreakIndex`).

`RoomSnapshot.status.pendingSupplementPlayerIds` lists players who have been asked to give a supplement but haven't spoken yet.

`GameRound.speechMode` and `RoomSnapshot.status.speechMode` distinguish `normal`, `supplement`, and `tieBreak` speech without adding another top-level game phase. `status.supplementIndex` identifies the currently active supplement request so the client never confuses it with an earlier supplement column.

## New Server Commands

| Command | Phase | Who | Description |
|---|---|---|---|
| `game.cancelVote` | `voting` or `tieBreak(vote)` | any voter | Remove own vote; allows re-voting |
| `game.cancelNightAction` | `night` | actor | Remove own night action |
| `game.requestSupplement` | completed `description` or `voting` | questioner | Ask specific players for extra speech; payload `{ playerIds: string[] }` |
| `game.enterBlankGuess` | `description`/`voting`/`tieBreak`/`night` | blank player | Enter the blocking blank-guess phase; one attempt only |
| `game.updateBlankGuessDraft` | `blankGuess` | the guesser | Broadcast in-progress input; payload `{ words: [string, string] }` (empty strings allowed) |
| `game.reviewBlankGuess` | `blankGuess` with `pendingReview` | questioner | Adjudicate a near-miss; payload `{ approve: boolean }` |

A vote of `targetId: ABSTAIN_TARGET_ID` (`"abstain"`, exported from `shared`) is a completed vote: it counts toward "everyone has voted" but adds to no player's tally. If abstentions reach the highest tally, the round goes to tie-break.

For `game.requestSupplement`:
- Allowed from `isDescriptionComplete` until the current normal vote resolves.
- The room switches to `description + supplement`; all clients leave the voting screen until the requested speeches finish.
- Existing votes remain recorded, but voting, cancel-vote, and phase advancement are blocked while a supplement is pending.
- Only one supplement request can be active at a time (`round.supplement` must be undefined).
- The server tracks `round.supplement = { index, requestedPlayerIds, donePlayers, resumePhase }`.
- When `donePlayers.length >= requestedPlayerIds.length`, supplement is cleared automatically and the room restores `resumePhase`.
- In `handleSubmitDescription`, the supplement check runs **before** the `ALREADY_SUBMITTED` check so that players who already gave a normal description can still submit a supplement.

## Vote Undo (Client)

`privateState.myCurrentVoteTargetId` (server-pushed, in `PrivateGameState`) is the source of truth for who the current player has voted for. Do **not** store vote target in local React state. When the player cancels, call `sendCommand("game.cancelVote", {})` and the server clears their vote + re-broadcasts state.

## Blank Player UX

Blank guessing is a **blocking phase**: the whole room stops and watches. The blank player gets exactly one attempt.

`BlankGuessPhase.tsx` exports:

- **`BlankGuessButton`** — top-right entry point, visible whenever `canSubmitBlankGuess && !blankGuessUsed && phase !== "gameOver" && phase !== "blankGuess"`. Clicking opens a confirmation dialog (one attempt only, everyone will watch), which then sends `game.enterBlankGuess`.
- **`BlankGuessStage`** — the `blankGuess` phase content. Dispatches on `status.blankGuessPlayerId === privateState.playerId`: the guesser gets the input UI, everyone else the spectate/adjudicate UI.

Live state is public in `RoomSnapshot.status`, because watching the guess unfold is the point of the phase:

| Field | Meaning |
|---|---|
| `blankGuessPlayerId` | who is guessing |
| `blankGuessReason` | `"active"` (self-initiated) / `"eliminated"` / `"finale"` (endgame while still alive) |
| `blankGuessDraft` | the guesser's in-progress input, throttled to ~220ms per push |
| `blankGuessPendingReview` | automatic comparison failed; blocked awaiting questioner adjudication |

The **real word pair is never** in the public snapshot — it reaches the questioner only via `privateState.globalWords`.

Adjudication exists because exact-match comparison kills near-misses (`香蕉` vs `香焦`). On a mismatch the server does *not* declare failure: it records the attempt (the one attempt is spent either way), sets `pendingReview`, and keeps the phase blocked until the questioner sends `game.reviewBlankGuess`. `approve: true` rewrites the record (`success`, `approvedByQuestioner`) and finishes the round as a blank win; `approve: false` falls through to the original failure path — `deferredWinner` if the endgame deferred one, otherwise back to `resumePhase`.

Elimination no longer auto-triggers a guess. `maybeEnterBlankGuess` only handles the finale case; otherwise the blank player decides when to spend the attempt.

## Player Marking (Local Only)

Player marks (`"unknown" | PlayerRole`) are **pure React local state** owned by `RoomPage.tsx`. They are never sent to the server and reset on page reload. Only active non-questioner players can mark identities. A player row opens a popover whose first row contains circular one-character choices for unknown/civilian/undercover and only the optional roles enabled in the current room. The row itself always displays the selected identity as a compact two-character label. Questioners and spectators see server-provided real roles instead, and game-over rows replace marks with revealed roles.

The host actions are in the same player-row popover below identity marks. Hosts may kick players or transfer host ownership during an active round. Kicking the current questioner aborts the round.

## RoomPage Layout

**Topbar** uses a three-section responsive grid:

- **Left**: back arrow, room name, room ID chip, test badge
- **Center** (`justify-center`): day counter (`第N天`) + a contextual pill (current word for civilians, angel word options, blank hint, questioner badge, or spectator badge)
- **Right** (`justify-end`): disconnect, mobile panel toggles, settings

When a player first receives a word, word options, or blank hint, `RoomPage` displays it in the center of `GameArea` for three seconds, then a shared-layout animation moves it into the topbar's center pill.

**Aside (desktop)** is a fixed `w-64` player panel. Its history button expands an absolute history matrix across the player panel and game area without changing either column's width; the chat panel stays outside the overlay. The sticky `w-64` first column reuses the complete interactive `PlayerRow`, including score, host state, role display, and popover actions. Mobile opens the same history overlay from the topbar.

`DescriptionTable` (from `DescriptionHistory.tsx`) renders one column per description group: `第N轮` (normal), `平票N` (amber, tieBreak), `补充N` (sky, supplement). When `players` are supplied, all current player rows remain visible even if they have no description in a column.

The room shell uses a light warm-yellow background. Player, game-action, and chat panels remain white; secondary rounded content blocks use a solid light gray. The client loads Noto Serif SC globally and hides scrollbar chrome without disabling scrolling.

## Tests

Backend tests are under `Server/test/` using `bun:test`. To run a single file:
```bash
bun test test/rules.test.ts
```

Key backend test files: `rules.test.ts` (pure domain logic), `connection-registry.test.ts` (connection unit tests), `room-service.test.ts` (service/state-machine integration and regressions), `app.test.ts` (HTTP + WS integration), `protocol-openapi.test.ts` (protocol conformance).

When adding fields to `GameRound` in the shared model, update all fixture objects in `rules.test.ts` accordingly (TypeScript will error otherwise).

Frontend Vitest files live beside source as `Client/src/**/*.test.{ts,tsx}`. Playwright tests live in `Client/e2e/`. Vitest intentionally only collects tests under `src`, so Playwright specs are never executed by both runners. See `Agents/Testing.md` for the complete test matrix and verification workflow.
