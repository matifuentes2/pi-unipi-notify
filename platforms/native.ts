/**
 * @pi-unipi/notify — Native OS notification platform
 *
 * Wraps node-notifier for cross-platform desktop notifications.
 * Windows: SnoreToast (no admin required)
 * macOS: terminal-notifier
 * Linux: notify-send / libnotify
 */

import notifier from "node-notifier";
import { execFile } from "child_process";
import { openSync, closeSync, writeSync } from "fs";
import { isWindowFocused } from "./focus.js";

/** Options for native notification */
export interface NativeNotificationOptions {
  /** Windows appID to show instead of "SnoreToast" */
  windowsAppId?: string;
  /**
   * When true, suppresses the notification if the terminal window is
   * the foreground (active) window. Only effective on platforms where
   * `isWindowFocused` is implemented (currently Windows).
   */
  suppressWhenFocused?: boolean;
}

/**
 * Thrown by sendNativeNotification when the notification was suppressed
 * because suppressWhenFocused is set and the terminal window is focused.
 *
 * Callers should catch this and treat it as intentional suppression,
 * NOT as a send failure.
 */
export class SuppressedError extends Error {
  constructor() {
    super("Notification suppressed: terminal window is focused");
    this.name = "SuppressedError";
  }
}

/**
 * Send a native OS notification.
 *
 * When `suppressWhenFocused` is true and `isWindowFocused()` returns true
 * (i.e. the terminal is the foreground window), the notification is
 * suppressed and the promise rejects with SuppressedError.
 *
 * Resolves when notification is shown, rejects with SuppressedError on
 * suppression or with a standard Error on failure.
 */
export async function sendNativeNotification(
  title: string,
  message: string,
  options?: NativeNotificationOptions
): Promise<void> {
  // Suppress if the terminal window is currently focused
  if (options?.suppressWhenFocused && await isWindowFocused()) {
    throw new SuppressedError();
  }

  // On macOS inside tmux, command-line Notification Center bridges such as
  // terminal-notifier and plain osascript can report success while the GUI
  // notification is dropped or attributed to a non-notifying helper app.  When
  // we can identify a terminal with a native notification escape protocol,
  // send the notification through the controlling terminal/tmux pane instead.
  // This makes the notification originate from the user's terminal app (kitty,
  // iTerm2, etc.) and works for Pi sessions running inside tmux.
  if (process.platform === "darwin") {
    if (sendMacTerminalNotification(title, message)) return;
    await sendMacNotification(title, message);
    return;
  }

  return new Promise((resolve, reject) => {
    notifier.notify(
      {
        title,
        message,
        appID: options?.windowsAppId,
      },
      (err: Error | null) => {
        if (err) {
          reject(
            new Error(
              `Native notification failed: ${err.message}`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}

/** Escape a value for an AppleScript string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Base64 encode UTF-8 text for terminal notification protocols. */
function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Detect the outer macOS terminal application, even when TERM_PROGRAM=tmux. */
function macTerminalBundleId(): string | undefined {
  const bundleId = process.env.__CFBundleIdentifier;
  if (bundleId) return bundleId;

  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram === "iTerm.app") return "com.googlecode.iterm2";
  if (termProgram === "Apple_Terminal") return "com.apple.Terminal";
  if (termProgram === "WezTerm") return "com.github.wez.wezterm";
  if (termProgram === "vscode") return "com.microsoft.VSCode";

  return undefined;
}

/** Wrap an escape sequence so tmux passes it through to the outer terminal. */
function tmuxPassthrough(seq: string): string {
  // tmux passthrough is: DCS "tmux;" ESC <payload> ST.  Use BEL as the inner
  // OSC terminator so the final ST belongs only to the tmux DCS wrapper.
  return process.env.TMUX ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq;
}

/** Write an escape sequence to the user's terminal, if this process has one. */
function writeTerminalEscape(seq: string): boolean {
  const payload = tmuxPassthrough(seq);

  // Prefer stderr because Pi owns it and it normally points at the user's pane.
  if (process.stderr.isTTY) {
    process.stderr.write(payload);
    return true;
  }

  // Some launch paths leave stdio piped but still have a controlling tty.
  try {
    const fd = openSync("/dev/tty", "w");
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** Send a macOS notification via terminal-native escape protocols. */
function sendMacTerminalNotification(title: string, message: string): boolean {
  const bundleId = macTerminalBundleId();

  if (bundleId === "net.kovidgoyal.kitty") {
    const id = `pi-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const app = b64("pi-coding-agent");
    const icon = b64("net.kovidgoyal.kitty");
    const titleSeq = `\x1b]99;i=${id}:d=0:e=1:p=title:f=${app}:n=${icon};${b64(title)}\x07`;
    const bodySeq = `\x1b]99;i=${id}:d=1:e=1:p=body:f=${app}:n=${icon};${b64(message)}\x07`;
    return writeTerminalEscape(titleSeq + bodySeq);
  }

  if (bundleId === "com.googlecode.iterm2") {
    // iTerm2 supports OSC 9 notifications.  Keep the payload single-line.
    const text = `${title}: ${message}`.replace(/[\r\n\t]+/g, " ");
    return writeTerminalEscape(`\x1b]9;${text}\x07`);
  }

  return false;
}

/** Send a macOS notification through the user's GUI session. */
function sendMacNotification(title: string, message: string): Promise<void> {
  const bundleId = macTerminalBundleId();
  const displayCommand =
    `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  const script = bundleId
    ? `tell application id ${appleScriptString(bundleId)} to ${displayCommand}`
    : displayCommand;

  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 5000 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `Native notification failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}
