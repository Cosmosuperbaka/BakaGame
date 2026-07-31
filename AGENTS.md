# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

BakaGame (server name: WhoIsFaker) is a real-time multiplayer party game — a digital "谁是卧底" (Who is the Undercover). All game state lives on the server and is pushed to clients over WebSocket. There is no REST API for game actions.

## Workspace Structure

Three independent packages — **no root-level package.json or shared scripts**:

| Package | Runtime | Location |
|---|---|---|
| `WhoIsFaker_Server` | Bun | `Server/` |
| `whoisfaker-client` | Node / npm | `Client/` |
| `@bakagame/shared` | (no build) | `packages/shared/` |

`@bakagame/shared` has no build step — it exports raw `.ts` source files. Both Server and Client import from it directly; bundlers handle transpilation.

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

### Shared (`cd packages/shared`)
```bash
npm run check        # tsc --noEmit
```

## Environment Variables

`Server/.env` (see `.env.example`):
```
CLIENT_URL=http://localhost:5173
SERVER_URL=http://localhost:4850
SERVER_PORT=4850
GIT_COMMIT=dev
```

`Client/.env` (see `.env.example`):
```
VITE_SERVER_URL=http://localhost:4850
```

## Architecture

### Communication Protocol

All WebSocket messages use a typed envelope defined in `packages/shared/src/protocol.ts`:

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

Routing (React Router v7): `/` → `HomePage` (lobby), `/room/:roomId` → `RoomPage`.

Client path alias: `@/` → `Client/src/`.

## Key Patterns

**Dual snapshot model**: every state push sends both `room.snapshot` (public, identical for all players) and `game.privateState` (per-connection secrets). Never derive private info from the public snapshot.

**Typed errors**: `AppError` with a `code` string (e.g. `"ROOM_NOT_FOUND"`, `"INVALID_PHASE"`) is used uniformly throughout the server. The transport layer converts them to `ErrorPacket`.

**Session persistence**: session tokens are stored in cookies (keyed by `roomId`) via `Client/src/lib/cookie.ts` for reconnect after page refresh. On reconnect, the client auto-attempts `room.reconnect`.

**Code comments in Chinese**: all business-logic comments in the server are in Simplified Chinese. Match this convention when adding comments.

## Test Mode

Room ID `"Oblivionis"` (case-insensitive) is a special test room:
- **Server**: bypasses minimum-player checks, allows solo play, accepts `test.jumpToPhase` and `test.setMyRole` commands.
- **Client**: `sendCommand` intercepts calls locally using mock data — no server required. The `TestController` component provides phase-jumping and role-switching UI.

## Game State Machine

```
waiting → assigningQuestioner → wordSubmission → description → voting
  → tieBreak (if tied) → night → description (next round; emits a transient daybreak notice)
  → blankGuess (if blank player triggered)
  → gameOver
```

Roles: `civilian`, `undercover`, `angel` (10+ players), `blank` (8+ players).  
Win conditions: `good` (all undercoverers eliminated), `undercover` (outnumber civilians), `blank` (guesses both words correctly), `aborted`.  
Minimum 4 players to start; `maxUndercoverCount = floor(playerCount / 4)`.

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
| `game.requestSupplement` | completed `description` or `voting` | questioner | Ask specific players for extra speech; payload `{ playerIds: string[] }` |

For `game.requestSupplement`:
- Allowed from `isDescriptionComplete` until the current normal vote resolves.
- Votes remain active and can be changed while a supplement is pending; vote resolution is blocked.
- Only one supplement request can be active at a time (`round.supplement` must be undefined).
- The server tracks `round.supplement = { index, requestedPlayerIds, donePlayers }`.
- When `donePlayers.length >= requestedPlayerIds.length`, supplement is cleared automatically.
- In `handleSubmitDescription`, the supplement check runs **before** the `ALREADY_SUBMITTED` check so that players who already gave a normal description can still submit a supplement.

## Vote Undo (Client)

`privateState.myCurrentVoteTargetId` (server-pushed, in `PrivateGameState`) is the source of truth for who the current player has voted for. Do **not** store vote target in local React state. When the player cancels, call `sendCommand("game.cancelVote", {})` and the server clears their vote + re-broadcasts state.

## Blank Player UX

`BlankGuessPhase.tsx` exports two components:

- **`BlankGuessButton`** — a floating `absolute bottom-4 right-4 z-10` button visible whenever `canSubmitBlankGuess && !blankGuessUsed && phase !== "gameOver"`. Opens a modal overlay (`absolute inset-0 z-20`) for guessing both words. This is **non-blocking**: it overlays the current phase UI without replacing it.
- **`BlankGuessWaiting`** — shown to all players during the `blankGuess` phase while waiting for the blank player to guess.

`GameArea.tsx` renders `<BlankGuessButton />` inside the outermost `relative` div so overlays position correctly. The `blankGuess` case in `PhaseContent` renders `<BlankGuessWaiting />`.

## Player Marking (Local Only)

Player marks (`"none" | "suspect" | "safe"`) are **pure React local state** in `PlayerList.tsx`. They are never sent to the server and reset on page reload. The mark indicator is a `w-4 h-4` dot on the left of each row; click cycles none → suspect (orange) → safe (emerald) → none.

## RoomPage Layout

**Topbar** uses `grid grid-cols-3` with three equal sections:

- **Left**: back arrow, room name, room ID chip, test badge
- **Center** (`justify-center`): day counter (`第N天`) + a contextual pill (current word for civilians, angel word options, blank hint, or questioner badge)
- **Right** (`justify-end`): disconnect, mobile panel toggles, settings

**Aside (desktop)** is an extensible panel on the left:
- Collapsed (default): `w-64`, shows `PlayerList` only.
- Expanded: `w-[580px]`, shows `PlayerList` (fixed `w-64`, `border-r`) + `DescriptionTable` in the remaining space.
- A `h-6 w-6` toggle button is anchored `absolute -right-3 top-1/2` on the panel's right edge.

`DescriptionTable` (from `DescriptionHistory.tsx`) renders one column per description group: `第N轮` (normal), `平票N` (amber, tieBreak), `补充N` (sky, supplement).

## Tests

All tests are under `Server/test/` using `bun:test`. To run a single file:
```bash
bun test test/rules.test.ts
```

Key test files: `rules.test.ts` (pure domain logic), `room-service.test.ts` (service unit tests), `app.test.ts` (HTTP + WS integration), `protocol-openapi.test.ts` (protocol conformance).

When adding fields to `GameRound` in the shared model, update all fixture objects in `rules.test.ts` accordingly (TypeScript will error otherwise).

No frontend tests exist.
