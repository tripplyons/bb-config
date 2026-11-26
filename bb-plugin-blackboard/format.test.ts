import { describe, expect, it, vi } from "vitest";
import { ago, cap, minutes, source } from "./format.js";
import type { NodeView } from "./rpc.js";

/** A minimal node standing in for a board fact. */
function node(data: Record<string, unknown>): NodeView {
  return {
    id: 1,
    kind: "fact",
    status: "open",
    summary: "x",
    detail: null,
    data,
    origin: "test",
    threadId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("minutes", () => {
  it("calls durations below a minute 'under a minute'", () => {
    expect(minutes(0)).toBe("under a minute");
    expect(minutes(20_000)).toBe("under a minute");
  });

  it("formats whole minutes", () => {
    expect(minutes(60_000)).toBe("1 min");
    expect(minutes(5 * 60_000)).toBe("5 min");
  });

  it("formats a whole number of hours without minutes", () => {
    expect(minutes(60 * 60_000)).toBe("1 h");
    expect(minutes(3 * 60 * 60_000)).toBe("3 h");
  });

  it("formats hours plus minutes", () => {
    expect(minutes(90 * 60_000)).toBe("1 h 30 min");
    expect(minutes(2 * 60 * 60_000 + 5 * 60_000)).toBe("2 h 5 min");
  });
});

describe("ago", () => {
  it("says 'Just now' for a timestamp less than a minute old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    try {
      expect(ago(Date.now())).toBe("Just now");
      expect(ago(Date.now() - 59_000)).toBe("Just now");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how long ago an older timestamp was", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    try {
      expect(ago(Date.now() - 5 * 60_000)).toBe("5 min ago");
      expect(ago(Date.now() - 90 * 60_000)).toBe("1 h 30 min ago");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cap", () => {
  it("uppercases the first letter of a lowercase string", () => {
    expect(cap("tool")).toBe("Tool");
  });

  it("leaves the rest of the string alone", () => {
    expect(cap("tOOL output")).toBe("TOOL output");
  });
});

describe("source", () => {
  it("turns underscores into spaces and capitalizes", () => {
    expect(source(node({ source: "tool_output" }))).toBe("Tool output");
    expect(source(node({ source: "user_input" }))).toBe("User input");
  });

  it("handles a single-word source", () => {
    expect(source(node({ source: "message" }))).toBe("Message");
  });
});
