import { describe, expect, it } from "vitest";

import { fillUnreleasedFromCommits, readLatestRelease, readUnreleased, releaseUnreleased } from "../src/changelog.js";

const CHANGELOG = "# Cambios\n\n## [Unreleased]\n\n### Added\n\n- Agrega recordatorios.\n\n### Fixed\n\n- Corrige $& en títulos.\n";

describe("changelog", () => {
  it.each([
    "",
    "# Changelog\n",
    "# Changelog\n\n## [Unreleased]\n",
    "# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Nope\r\n\r\n- Manual entry.\r\n",
  ])("should fill missing or existing unreleased blocks from every commit when the document is %j", (document) => {
    const commits = [
      { sha: "8fc02455aaaa", subject: "fix: corrige $& y títulos (#75)" },
      { sha: "123456789abc", subject: "chore: update tooling" },
      { sha: "abcdef012345", subject: "Merge pull request #74" },
    ];

    const result = fillUnreleasedFromCommits(document, commits);

    expect(readUnreleased(result)).toMatchObject({
      exists: true,
      entryCount: 3,
      unknownSections: [],
      body: "- 8fc0245 fix: corrige $& y títulos (#75)\n- 1234567 chore: update tooling\n- abcdef0 Merge pull request #74",
    });
    expect(fillUnreleasedFromCommits(result, commits)).toBe(result);
  });

  it.each([true, false])("should preserve the introduction and published history when an unreleased block exists: %j", (hasUnreleased) => {
    const introduction = "# Changes\r\n\r\nRelease history.\r\n\r\n";
    const history = "## [0.1.0] - 2026-01-01\r\n\r\n- Old entry.\r\n\r\n## 0.0.1 - 2025-12-01\r\n\r\n- First entry.\r\n";
    const existing = `${introduction}${hasUnreleased ? "## [Unreleased]\r\n\r\n- Manual entry.\r\n\r\n" : ""}${history}`;

    const result = fillUnreleasedFromCommits(existing, [{ sha: "123456789abc", subject: "feat: new entry" }]);
    const released = releaseUnreleased(result, "0.2.0", "2026-10-02");

    expect(result.startsWith(introduction.trimEnd())).toBe(true);
    expect(released.endsWith(history)).toBe(true);
    expect(readLatestRelease(released)).toEqual({ version: "0.2.0", entryCount: 1 });
    expect(released).not.toContain("Manual entry.");
  });

  it("should reject generation when no commits are available", () => {
    expect(() => fillUnreleasedFromCommits(CHANGELOG, [])).toThrow(/no commits/);
  });

  it("should move [Unreleased] under the released version and leave an empty [Unreleased] on top", () => {
    const released = releaseUnreleased(CHANGELOG, "0.94.0", "2026-09-26");

    expect(released).toBe(
      "# Cambios\n\n## [Unreleased]\n\n## [0.94.0] - 2026-09-26\n\n### Added\n\n- Agrega recordatorios.\n\n### Fixed\n\n- Corrige $& en títulos.\n\n"
    );
    expect(readUnreleased(released).entryCount).toBe(0);
    expect(readLatestRelease(released)).toEqual({ version: "0.94.0", entryCount: 2 });
  });

  it("should read legacy release headings without brackets and CRLF changelogs", () => {
    const legacy = "# Cambios\r\n\r\n## [Unreleased]\r\n\r\n- Nuevo.\r\n\r\n## 0.6.0 - 2026-09-23\r\n\r\n- Viejo.\r\n";

    expect(readUnreleased(legacy)).toMatchObject({ exists: true, entryCount: 1 });
    expect(readLatestRelease(legacy)).toEqual({ version: "0.6.0", entryCount: 1 });
  });

  it("should refuse an empty or missing [Unreleased] block and unknown sections", () => {
    expect(() => releaseUnreleased("# Cambios\n\n## [Unreleased]\n\n### Added\n", "0.94.0", "2026-09-26")).toThrow(/no changes/);
    expect(() => releaseUnreleased("# Cambios\n", "0.94.0", "2026-09-26")).toThrow(/\[Unreleased\]/);
    expect(() => releaseUnreleased(CHANGELOG.replace("### Fixed", "### Mejoras"), "0.94.0", "2026-09-26")).toThrow(/Mejoras/);
  });

});
