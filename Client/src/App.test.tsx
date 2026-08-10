import type { ReactNode } from "react";

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => ({
  MotionConfig: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/contexts/GameContext", () => ({
  GameProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/contexts/SongGuessrContext", () => ({
  SongGuessrProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/Toast", () => ({
  ToastContainer: () => null,
  SongGuessrToastContainer: () => null,
}));
vi.mock("@/pages/LandingPage", () => ({ default: () => <h1>landing-page</h1> }));
vi.mock("@/pages/WhoIsFakerPage", () => ({ default: () => <h1>faker-lobby</h1> }));
vi.mock("@/pages/RoomPage", () => ({ default: () => <h1>room-page</h1> }));
vi.mock("@/pages/SongGuessrPage", () => ({ default: () => <h1>song-lobby</h1> }));
vi.mock("@/pages/SongGuessrRoomPage", () => ({ default: () => <h1>song-room</h1> }));

import App from "./App";

describe("application routing regressions", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each(["/animecharguessr"])(
    "redirects removed route %s to the landing page",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByText("landing-page")).toBeInTheDocument();
      await waitFor(() => expect(window.location.pathname).toBe("/"));
    },
  );

  it("redirects an invalid game sub-route to the game lobby", async () => {
    window.history.replaceState({}, "", "/whoisfaker/not-a-room");
    render(<App />);

    expect(await screen.findByText("faker-lobby")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/whoisfaker"));
  });

  it("keeps valid room routes mounted", async () => {
    window.history.replaceState({}, "", "/whoisfaker/room/AbCd");
    render(<App />);

    expect(await screen.findByText("room-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/whoisfaker/room/AbCd");
  });

  it("mounts the Song Guessr lobby", async () => {
    window.history.replaceState({}, "", "/songguessr");
    render(<App />);

    expect(await screen.findByText("song-lobby")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/songguessr");
  });

  it("keeps valid Song Guessr room routes mounted", async () => {
    window.history.replaceState({}, "", "/songguessr/room/1234");
    render(<App />);

    expect(await screen.findByText("song-room")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/songguessr/room/1234");
  });

  it("redirects an invalid Song Guessr sub-route to its lobby", async () => {
    window.history.replaceState({}, "", "/songguessr/not-a-room");
    render(<App />);

    expect(await screen.findByText("song-lobby")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/songguessr"));
  });
});
