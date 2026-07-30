import { describe, expect, it, vi } from "vitest";
import { createConsoleLogger, formatLogEntry } from "../src/log.ts";

const NOW = new Date(2026, 6, 30, 10, 15, 42);

describe("console logs", () => {
  it("aligns ordinary, warning, and ready entries for quick scanning", () => {
    expect(formatLogEntry("INFO", "Configuration: open-agent.config.json", NOW)).toBe(
      "10:15:42  INFO   Configuration: open-agent.config.json",
    );
    expect(formatLogEntry("WARN", "Repository is unprotected", NOW)).toBe(
      "10:15:42  WARN   Repository is unprotected",
    );
    expect(formatLogEntry("READY", "Listening for @-mentions", NOW)).toBe(
      "10:15:42  READY  Listening for @-mentions",
    );
  });

  it("indents multiline diagnostics beneath their severity label", () => {
    expect(formatLogEntry("ERROR", "Startup failed:\n  - missing token", NOW)).toBe(
      "10:15:42  ERROR  Startup failed:\n                   - missing token",
    );
  });

  it("prints a banner and routes each severity to the matching console stream", () => {
    const output = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = createConsoleLogger({
      console: output,
      colors: false,
      now: () => NOW,
    });

    log.banner();
    log.info("Checking configuration");
    log.warn("Protection is missing");
    log.ready("Listening");
    log.error("Startup failed");

    expect(output.log.mock.calls[0]?.[0]).toContain("open-agent · Slack coworker");
    expect(output.log.mock.calls[1]?.[0]).toContain("INFO   Checking configuration");
    expect(output.warn).toHaveBeenCalledWith(
      "10:15:42  WARN   Protection is missing",
    );
    expect(output.log.mock.calls[2]?.[0]).toContain("READY  Listening");
    expect(output.error).toHaveBeenCalledWith("10:15:42  ERROR  Startup failed");
  });
});
