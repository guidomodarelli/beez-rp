/**
 * Strict UTF-8 decoding of the files the release rewrites: a file that is not valid UTF-8 (such as
 * one saved as ISO-8859-1) is rejected instead of having its bytes replaced by U+FFFD, so rewriting
 * its version never changes any other byte. A byte order mark is kept as part of the text, so
 * encoding the decoded text again gives back the same bytes.
 *
 * @module create-version/utf8-text
 */

/** Byte that ends a line; it never appears inside a multi-byte UTF-8 sequence. */
const LINE_FEED_BYTE = 0x0a;

/** Decoder that throws on invalid UTF-8 and keeps a leading byte order mark in the text. */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bytes that are not valid UTF-8. */
export class InvalidUtf8Error extends Error {
  /**
   * @param {number} lineNumber - 1-based line holding the first invalid byte.
   * @param {unknown} cause - Error of the decoder.
   */
  constructor(lineNumber, cause) {
    super(`beez-rp:decodeStrictUtf8 invalid UTF-8 at line ${lineNumber}`, { cause });
    this.name = "InvalidUtf8Error";
    this.lineNumber = lineNumber;
  }
}

/**
 * Finds the 1-based line holding the first invalid UTF-8 byte, decoding line by line.
 *
 * @param {Uint8Array} bytes - Content already known to be invalid UTF-8.
 * @returns {number} Line of the first invalid byte.
 */
function findFirstInvalidLine(bytes) {
  let lineStart = 0;
  let lineNumber = 1;

  while (lineStart < bytes.length) {
    const lineFeedIndex = bytes.indexOf(LINE_FEED_BYTE, lineStart);
    const lineEnd = lineFeedIndex === -1 ? bytes.length : lineFeedIndex + 1;

    try {
      STRICT_UTF8_DECODER.decode(bytes.subarray(lineStart, lineEnd));
    } catch {
      return lineNumber;
    }

    lineStart = lineEnd;
    lineNumber += 1;
  }

  return lineNumber;
}

/**
 * Decodes bytes as UTF-8, rejecting any invalid sequence instead of replacing it.
 *
 * @param {Uint8Array} bytes - File content.
 * @returns {string} Text whose UTF-8 encoding is exactly `bytes`, byte order mark included.
 * @throws {InvalidUtf8Error} When the bytes are not valid UTF-8.
 */
export function decodeStrictUtf8(bytes) {
  try {
    return STRICT_UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new InvalidUtf8Error(findFirstInvalidLine(bytes), error);
  }
}
