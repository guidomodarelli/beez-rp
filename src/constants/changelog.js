/**
 * Keep a Changelog contract used to read and release `CHANGELOG.md`.
 *
 * @module constants/changelog
 */

/** Changelog file released together with `package.json`. */
export const CHANGELOG_FILE = "CHANGELOG.md";

/** Heading of the block that collects changes not yet released. */
export const UNRELEASED_HEADING = "## [Unreleased]";

/** Change types allowed as `###` sections, in Keep a Changelog order. */
export const CHANGE_TYPES = Object.freeze(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);

/** Any release-level heading: `## [Unreleased]`, `## [0.7.0] - 2026-09-26` or `## 0.6.0 - 2026-09-23`. */
export const RELEASE_HEADING_PATTERN = /^## +\[?([^\]\s]+)\]?[^\n]*$/gmu;

/** Unreleased heading, case-insensitive, as its own line. */
export const UNRELEASED_LINE_PATTERN = /^## +\[Unreleased\][ \t]*$/imu;

/** A change entry line. */
export const ENTRY_LINE_PATTERN = /^\s*- +\S/mu;

/** A change-type section heading inside a release block. */
export const SECTION_HEADING_PATTERN = /^### +(.+?)\s*$/gmu;

/** Leading whitespace left before the next block after moving `[Unreleased]`. */
export const LEADING_WHITESPACE_PATTERN = /^\s+/u;

/** Line break in a changelog written on any platform. */
export const LINE_BREAK_PATTERN = /\r?\n/u;
