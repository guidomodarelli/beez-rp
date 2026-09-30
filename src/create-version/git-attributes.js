/**
 * Git attributes (`.gitattributes`) that change how `create-version` can trust a file: a `filter`
 * driver rewrites the content Git stores (clean) and checks out (smudge), so neither the committed
 * blob of a release file is exactly what the release wrote, nor does comparing a loaded module with
 * `HEAD` prove that Node ran the committed bytes. Such files are rejected instead of reasoning about
 * what each filter does; line-ending normalization (`text`, `eol`, `core.autocrlf`) is not a filter
 * and stays allowed.
 *
 * @module create-version/git-attributes
 */

import { CHECK_ATTR_FIELDS_PER_ENTRY, GIT_FILTER_ATTRIBUTE, GIT_INACTIVE_ATTRIBUTE_VALUES } from "../constants/create-version.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 */

/**
 * Lists the files Git applies a `filter` attribute to.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string[]} files - Repository-relative paths separated with `/`.
 * @returns {Promise<string[]>} The filtered files, in the order of `files`.
 * @throws {Error} When `git check-attr` fails.
 */
export async function listFilteredFiles(reader, files) {
  if (files.length === 0) {
    return [];
  }

  // `git check-attr` takes paths, not pathspecs: a name such as `:version` needs no escaping.
  const fields = (await reader.git(["check-attr", "-z", GIT_FILTER_ATTRIBUTE, "--", ...files])).split("\0");
  const filteredFiles = new Set();

  for (let index = 0; index + CHECK_ATTR_FIELDS_PER_ENTRY <= fields.length; index += CHECK_ATTR_FIELDS_PER_ENTRY) {
    const [file, , value] = fields.slice(index, index + CHECK_ATTR_FIELDS_PER_ENTRY);
    if (!GIT_INACTIVE_ATTRIBUTE_VALUES.includes(value)) {
      filteredFiles.add(file);
    }
  }

  return files.filter((file) => filteredFiles.has(file));
}
