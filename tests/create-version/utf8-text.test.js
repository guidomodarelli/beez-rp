import { describe, expect, it } from "vitest";

import { decodeStrictUtf8 } from "../../src/create-version/utf8-text.js";

/** Byte of ISO-8859-1 `é`, never valid on its own in UTF-8. */
const LATIN1_E_ACUTE_BYTE = 0xe9;

/**
 * Builds content whose third line holds an ISO-8859-1 byte.
 *
 * @param {string} lineTerminator - Terminator between the lines.
 * @returns {Buffer} Invalid UTF-8 content.
 */
function contentWithInvalidThirdLine(lineTerminator) {
  return Buffer.concat([Buffer.from(`primera${lineTerminator}segunda${lineTerminator}caf`, "utf8"), Buffer.from([LATIN1_E_ACUTE_BYTE]), Buffer.from(lineTerminator, "utf8")]);
}

describe("decodeStrictUtf8", () => {
  it.each([
    ["\n", "line feeds"],
    ["\r\n", "carriage return and line feed pairs"],
    ["\r", "lone carriage returns"],
  ])("should report the line of the first invalid byte with %j (%s) line endings", (lineTerminator) => {
    expect(() => decodeStrictUtf8(contentWithInvalidThirdLine(lineTerminator))).toThrow(expect.objectContaining({ name: "InvalidUtf8Error", lineNumber: 3 }));
  });

  it("should decode valid UTF-8 keeping the byte order mark", () => {
    expect(decodeStrictUtf8(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("Versión\r", "utf8")]))).toBe("\uFEFFVersión\r");
  });
});
