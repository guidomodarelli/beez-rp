import { describe, expect, it } from "vitest";

import { updateVersionMarkers, VersionBlockError } from "../src/version-files.js";

describe("updateVersionMarkers", () => {
  it("rewrites the version of lines marked with beez-rp-version or x-release-please-version only", () => {
    const content = [
      'export const VERSION = "0.5.6"; // beez-rp-version',
      '  .version("0.5.6"); // x-release-please-version',
      'const untouched = "0.5.6";',
      "",
    ].join("\n");

    const update = updateVersionMarkers(content, "0.6.0");

    expect(update.content).toBe(
      ['export const VERSION = "0.6.0"; // beez-rp-version', '  .version("0.6.0"); // x-release-please-version', 'const untouched = "0.5.6";', ""].join("\n")
    );
    expect(update).toMatchObject({ markedLines: 2, replacements: 2 });
  });

  it("rewrites every version inside start/end blocks and nothing around them", () => {
    const content = [
      "before 1.0.0",
      "<!-- beez-rp-start-version -->",
      "npm i pkg@1.0.0 other@1.0.0-beta.2",
      "<!-- beez-rp-end -->",
      "# x-release-please-start-version",
      "image: app:1.0.0+build.7",
      "# x-release-please-end",
      "after 1.0.0",
    ].join("\n");

    const update = updateVersionMarkers(content, "1.1.0");

    expect(update.content.split("\n")).toEqual([
      "before 1.0.0",
      "<!-- beez-rp-start-version -->",
      "npm i pkg@1.1.0 other@1.1.0",
      "<!-- beez-rp-end -->",
      "# x-release-please-start-version",
      "image: app:1.1.0",
      "# x-release-please-end",
      "after 1.0.0",
    ]);
    expect(update.replacements).toBe(3);
  });

  it("keeps CRLF line endings and ignores longer dotted numbers", () => {
    const update = updateVersionMarkers('v = "2.0.0"; // beez-rp-version\r\nip = "10.0.0.1"; // beez-rp-version\r\n', "2.1.0");

    expect(update.content).toBe('v = "2.1.0"; // beez-rp-version\r\nip = "10.0.0.1"; // beez-rp-version\r\n');
    expect(update).toMatchObject({ markedLines: 2, replacements: 1 });
  });

  it("treats a lone carriage return as a line end, rewriting only the marked line and keeping every terminator", () => {
    const content = "before 1.0.0\rmarked 1.0.0 # beez-rp-version\rafter 1.0.0\r\nlast 1.0.0\n";

    const update = updateVersionMarkers(content, "1.1.0");

    expect(update.content).toBe("before 1.0.0\rmarked 1.1.0 # beez-rp-version\rafter 1.0.0\r\nlast 1.0.0\n");
    expect(update).toMatchObject({ markedLines: 1, replacements: 1 });
  });

  it("points at the right line of a block error in a file with carriage-return line endings", () => {
    let caughtError;
    try {
      updateVersionMarkers("a 1.0.0\r\nb 1.0.0\rc 1.0.0\n# beez-rp-end\r", "1.1.0");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(VersionBlockError);
    expect(caughtError).toMatchObject({ problem: "unopened", lineNumber: 4, marker: "beez-rp-end" });
  });

  it.each([
    { name: "a period ending the sentence", line: "Current release is 1.2.3. <!-- beez-rp-version -->", expected: "Current release is 2.0.0. <!-- beez-rp-version -->" },
    { name: "a prerelease with dotted identifiers", line: "tag 1.2.3-beta.1 # beez-rp-version", expected: "tag 2.0.0 # beez-rp-version" },
    { name: "a prerelease and build metadata before a period", line: "Use 1.2.3-rc.1+build.5. # beez-rp-version", expected: "Use 2.0.0. # beez-rp-version" },
  ])("rewrites a marked version followed by $name", ({ line, expected }) => {
    const update = updateVersionMarkers(`${line}\n`, "2.0.0");

    expect(update.content).toBe(`${expected}\n`);
    expect(update.replacements).toBe(1);
  });

  it("leaves numbers with a fourth dotted component untouched", () => {
    const update = updateVersionMarkers("build 1.2.3.4 # beez-rp-version\n", "2.0.0");

    expect(update).toMatchObject({ content: "build 1.2.3.4 # beez-rp-version\n", replacements: 0 });
  });

  it.each([
    {
      name: "a start marker never closed, instead of rewriting every version after it",
      lines: ["<!-- beez-rp-start-version -->", "npm i pkg@1.0.0", "<!-- beez-rp-finish -->", "unrelated 1.0.0"],
      expected: { problem: "unterminated", lineNumber: 1, marker: "beez-rp-start-version" },
    },
    {
      name: "an end marker outside any block",
      lines: ['v = "1.0.0"; // beez-rp-version', "# x-release-please-end"],
      expected: { problem: "unopened", lineNumber: 2, marker: "x-release-please-end" },
    },
    {
      name: "a start marker inside a block still open",
      lines: ["# beez-rp-start-version", "a 1.0.0", "# beez-rp-start-version", "b 1.0.0", "# beez-rp-end"],
      expected: { problem: "nested", lineNumber: 3, marker: "beez-rp-start-version", openingLineNumber: 1, openingMarker: "beez-rp-start-version" },
    },
    {
      name: "a block closed with the end marker of the other tool",
      lines: ["# x-release-please-start-version", "a 1.0.0", "# beez-rp-end", "b 1.0.0"],
      expected: { problem: "mismatched", lineNumber: 3, marker: "beez-rp-end", openingLineNumber: 1, openingMarker: "x-release-please-start-version" },
    },
  ])("rejects $name, pointing at the offending line", ({ lines, expected }) => {
    let caughtError;
    try {
      updateVersionMarkers(lines.join("\n"), "1.1.0");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(VersionBlockError);
    expect(caughtError).toMatchObject(expected);
  });

  it("reports nothing to replace when no line is marked", () => {
    expect(updateVersionMarkers('const VERSION = "1.0.0";\n', "1.0.1")).toMatchObject({ markedLines: 0, replacements: 0 });
  });
});
