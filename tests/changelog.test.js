import { describe, expect, it } from "vitest";

import { readLatestRelease, readUnreleased, releaseUnreleased } from "../src/changelog.js";
import { buildChangelogPrompt } from "../src/changelog-ai.js";

const CHANGELOG = "# Cambios\n\n## [Unreleased]\n\n### Added\n\n- Agrega recordatorios.\n\n### Fixed\n\n- Corrige $& en títulos.\n";

describe("changelog", () => {
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

  it("should ask Codex for Keep a Changelog entries from the unreleased commits only", () => {
    const prompt = buildChangelogPrompt([{ sha: "8fc02455aaaa", subject: "Add event reminders (#75)" }], "quien consume el paquete");

    expect(prompt).toContain("## [Unreleased]");
    expect(prompt).toContain("- 8fc0245 Add event reminders (#75)");
    expect(prompt).toContain("quien consume el paquete");
    expect(prompt).toContain("Modificá únicamente CHANGELOG.md");
  });
});
