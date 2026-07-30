import type { Logger } from "./ports/log.ts";

type ConsoleLike = Pick<Console, "log" | "warn" | "error">;
type LogLevel = "INFO" | "WARN" | "READY" | "ERROR";

export interface ConsoleLogger extends Logger {
  banner(): void;
  ready(message: string): void;
  error(message: string): void;
}

interface ConsoleLoggerOptions {
  console?: ConsoleLike;
  colors?: boolean;
  now?: () => Date;
}

const RESET = "\u001B[0m";
const DIM = "\u001B[2m";
const CYAN = "\u001B[36m";
const GREEN = "\u001B[32m";
const YELLOW = "\u001B[33m";
const RED = "\u001B[31m";

/**
 * Human-facing process logs.
 *
 * Startup is when an operator is most likely to read every line, so the default logger
 * favors a compact scan shape over machine-oriented JSON: time, aligned severity, then the
 * existing diagnostic. Explicit newlines keep their structure and align under the message.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): ConsoleLogger {
  const output = options.console ?? console;
  const colors = options.colors ?? Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
  const now = options.now ?? (() => new Date());
  const entry = (level: LogLevel, message: string): string =>
    formatLogEntry(level, message, now(), colors);

  return {
    banner(): void {
      output.log(formatBanner(colors));
    },
    info(message): void {
      output.log(entry("INFO", message));
    },
    warn(message): void {
      output.warn(entry("WARN", message));
    },
    ready(message): void {
      output.log(entry("READY", message));
    },
    error(message): void {
      output.error(entry("ERROR", message));
    },
  };
}

export function formatLogEntry(
  level: LogLevel,
  message: string,
  at: Date,
  colors = false,
): string {
  const timestamp = at.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const label = level.padEnd(5);
  const plainPrefix = `${timestamp}  ${label}  `;
  const continuation = " ".repeat(plainPrefix.length);
  const body = message.split("\n").join(`\n${continuation}`);
  if (!colors) return `${plainPrefix}${body}`;

  const color =
    level === "READY" ? GREEN : level === "WARN" ? YELLOW : level === "ERROR" ? RED : CYAN;
  return `${DIM}${timestamp}${RESET}  ${color}${label}${RESET}  ${body}`;
}

function formatBanner(colors: boolean): string {
  const banner = [
    "╭──────────────────────────────────────────────╮",
    "│  open-agent · Slack coworker                 │",
    "│  Starting preflight checks…                  │",
    "╰──────────────────────────────────────────────╯",
  ].join("\n");
  return colors ? `${CYAN}${banner}${RESET}` : banner;
}
