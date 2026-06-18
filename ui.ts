/**
 * Console presentation helpers. The goal is output that reads like documentation:
 * a reader (human or AI agent) should understand what the script is about to do,
 * what it is doing, and what happened - without reading the source first.
 *
 * Two deliberate choices:
 *   - No emojis. Status is plain words ("ok", "reused", "blocked").
 *   - Color and the spinner are enabled only when stdout is a real terminal.
 *     Piped/redirected output (CI, or an AI agent capturing the run) is then
 *     plain text with no ANSI escapes, so it can be relayed verbatim.
 *
 * Uses the Deno standard library only (no third-party UI deps):
 *   @std/fmt/colors        - ANSI styling
 *   @std/cli/unstable-spinner - the in-progress spinner
 */
import { bold, cyan, dim, green, red, setColorEnabled, yellow } from "@std/fmt/colors";
import { Spinner } from "@std/cli/unstable-spinner";

const interactive = Deno.stdout.isTerminal();
setColorEnabled(interactive);

/** Banner: a bold title and a one-line description of what the script does. */
export const heading = (title: string, description: string): void => {
  console.log(`\n${bold(title)}`);
  console.log(dim(description));
};

/** A bold section header, e.g. "Configuration", "Plan", "Result". */
export const section = (name: string): void => console.log(`\n${bold(name)}`);

/** Aligned "label  value" line. The label is padded to `pad` columns. */
export const kv = (label: string, value: string, pad = 12): void =>
  console.log(`  ${dim(label.padEnd(pad))}  ${value}`);

/** A dim, indented line, e.g. a docs link or an aside. */
export const note = (text: string): void => console.log(`  ${dim(text)}`);

/** One numbered line in the up-front plan (shown before anything runs). */
export const planItem = (n: number, title: string, detail: string): void =>
  console.log(`  ${cyan(String(n) + ".")} ${title.padEnd(16)} ${dim(detail)}`);

/** Block-level result, printed once at the end. */
export const done = (text: string): void => console.log(`\n${green(text)}`);
export const failed = (text: string): void => console.log(`\n${red(text)}`);

/**
 * Begin a step and return a handle to close it with a result.
 *
 * Interactive terminal: a spinner shows the running step, then is replaced by the
 * result line. Non-interactive: a "..." line is printed, then the result on the
 * next line - so a captured log reads top to bottom with no escape codes.
 */
export const step = (n: number, total: number, title: string) => {
  const label = `[${n}/${total}] ${title}`;
  let spinner: Spinner | undefined;
  if (interactive) {
    spinner = new Spinner({ message: `${label} ...` });
    spinner.start();
  } else {
    console.log(`  ${label} ...`);
  }
  const close = (status: string, detail?: string): void => {
    spinner?.stop();
    const tail = detail ? `  ${dim(detail)}` : "";
    console.log(interactive ? `  ${status}  ${label}${tail}` : `     ${status}${tail}`);
  };
  return {
    /** Update the in-progress message (e.g. while waiting/retrying). */
    update: (message: string): void => {
      if (spinner) spinner.message = `${label} - ${message}`;
      else console.log(`     ${dim(message)}`);
    },
    /** Step succeeded (work was performed). */
    ok: (detail?: string): void => close(green("ok"), detail),
    /** Step was a no-op because the resource already existed (re-run path). */
    reused: (detail?: string): void => close(cyan("reused"), detail),
    /** Step was intentionally not executed (e.g. dry run). */
    skip: (detail?: string): void => close(yellow("skip"), detail),
    /** Step failed; the caller prints the explanation. */
    fail: (): void => close(red("fail")),
  };
};

/**
 * Silence the Crossmint SDK's own console logger, which prefixes every line with
 * "[SDK]", so the step output stays clean. Only "[SDK]"-prefixed lines are dropped;
 * this script's output and any unrelated logging are untouched. Pass `false`
 * (the script's --debug flag) to keep the SDK logs for troubleshooting.
 */
export const quietSdkLogs = (quiet: boolean): void => {
  if (!quiet) return;
  const isSdkLine = (args: unknown[]): boolean =>
    typeof args[0] === "string" && args[0].startsWith("[SDK]");
  const levels = ["log", "info", "warn", "error", "debug"] as const;
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      if (!isSdkLine(args)) original(...args);
    };
  }
};
