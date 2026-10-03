/**
 * Parses native registry JSONC manifests while preserving character offsets for version-only edits.
 *
 * @module create-version/jsonc
 */

/**
 * Replaces comments and trailing commas with whitespace, without touching string values or offsets.
 *
 * @param {string} content - JSON or JSONC text.
 * @returns {string} JSON text with the same length and line breaks.
 * @throws {Error} When a block comment is unterminated.
 */
export function normalizeJsonc(content) {
  const characters = content.split("");
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  if (characters[0] === "\uFEFF") characters[0] = " ";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const next = characters[index + 1];
    if (lineComment || blockComment) {
      if (blockComment && character === "*" && next === "/") {
        characters[index] = characters[index + 1] = " ";
        blockComment = false;
        index += 1;
      } else if (character === "\n" || character === "\r") {
        lineComment = false;
      } else characters[index] = " ";
    } else if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "/" && (next === "/" || next === "*")) {
      lineComment = next === "/";
      blockComment = next === "*";
      characters[index] = characters[index + 1] = " ";
      index += 1;
    }
  }
  if (blockComment) throw new Error("Unterminated JSONC block comment");
  quoted = false;
  escaped = false;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      let following = index + 1;
      while (/\s/u.test(characters[following] ?? "") && following < characters.length) following += 1;
      if (characters[following] === "]" || characters[following] === "}") characters[index] = " ";
    }
  }
  return characters.join("");
}

/**
 * Reads a native JSONC manifest as JSON, preserving comments in the caller's source text.
 *
 * @param {string} content - JSONC manifest text.
 * @returns {Record<string, unknown>} Parsed manifest.
 * @throws {Error} When the manifest is not an object or is malformed.
 */
export function parseJsoncManifest(content) {
  const parsed = JSON.parse(normalizeJsonc(content));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Registry manifest must be a JSON object");
  return parsed;
}
