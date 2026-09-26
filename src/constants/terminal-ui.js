/**
 * Layout, ANSI and key contracts of the dependency-free terminal UI.
 *
 * @module constants/terminal-ui
 */

/** Widest box drawn, so lines stay readable on large terminals. */
export const MAX_BOX_WIDTH = 84;

/** Width assumed when stdout does not report its columns. */
export const FALLBACK_TERMINAL_WIDTH = 80;

/** Columns kept free at the right of the terminal when sizing a box. */
export const TERMINAL_RIGHT_MARGIN = 2;

/** Horizontal padding inside a box, per side. */
export const BOX_PADDING = 1;

/** Width of the label column of status rows. */
export const ROW_LABEL_WIDTH = 16;

/** Spinner animation frames. */
export const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

/** Delay between spinner frames. */
export const SPINNER_INTERVAL_MS = 80;

/** Exit code conventionally used after Ctrl+C. */
export const INTERRUPTED_EXIT_CODE = 130;

/** Splits styled text into ANSI escape sequences and single code points. */
export const ANSI_TOKEN_PATTERN = /\x1b\[[0-9;]*m|[\s\S]/gu;

/** First character of every ANSI escape sequence. */
export const ANSI_ESCAPE = "\x1b";

/** ANSI control sequences used by boxes, spinners and prompts. */
export const ANSI_SEQUENCE = Object.freeze({
  reset: "\x1b[0m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\r\x1b[2K",
  clearBelow: "\x1b[0J",
});

/** Border color of each box tone. */
export const BOX_TONE = Object.freeze({
  neutral: "gray",
  info: "cyan",
  success: "green",
  warning: "yellow",
  danger: "red",
  accent: "magenta",
});

/** Nerd Font glyphs (Font Awesome and Octicons sets) used as status icons. */
export const ICON_GLYPH = Object.freeze({
  success: "", // nf-fa-check
  failure: "", // nf-fa-times
  warning: "", // nf-fa-warning
  info: "", // nf-fa-info_circle
  pending: "", // nf-fa-circle_o
  arrow: "", // nf-fa-chevron_right
  bullet: "", // nf-oct-dot_fill
  star: "", // nf-fa-star
  rocket: "", // nf-fa-rocket
});

/** Label/value rows (`renderRow`): the value starts after a gap of two or more spaces. */
export const VALUE_COLUMN_PATTERN = /^\s*\S(?:.*?\S)?\s{2,}(?=\S)/u;

/** Leading marker (icon, arrow, bullet or `1.`, never a word) followed by a space, used as hanging indent. */
export const HANGING_MARKER_PATTERN = /^(\s*)((?:[^\p{L}\p{N}\s]{1,2}|\d{1,2}\.)\s+)?/u;

/** Options that can be picked with a single digit key (1-9). */
export const MAX_NUMBERED_OPTIONS = 9;

/** A single digit key that picks a numbered option. */
export const NUMBER_KEY_PATTERN = /^[1-9]$/u;

/** Seconds in a minute, used to format durations. */
export const SECONDS_PER_MINUTE = 60;

/** Milliseconds in a second, used to format durations. */
export const MILLISECONDS_PER_SECOND = 1000;

/** Key names (`readline` keypress events) handled by the select prompt. */
export const PROMPT_KEY = Object.freeze({
  interrupt: "c",
  previous: Object.freeze(["up", "k"]),
  next: Object.freeze(["down", "j", "tab"]),
  confirm: Object.freeze(["return", "enter"]),
});
