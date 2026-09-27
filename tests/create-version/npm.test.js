import { describe, expect, it } from "vitest";

import { NPM_DIST_TAG } from "../../src/constants/create-version.js";
import { buildNpmPublishArguments } from "../../src/create-version/npm.js";

/** Options every `npm publish` call carries after the publish target. */
const PUBLISH_OPTIONS = ["--access", "public", "--tag", NPM_DIST_TAG];

describe("buildNpmPublishArguments", () => {
  it("publishes the working tree when there is no prepared artifact", () => {
    expect(buildNpmPublishArguments(null)).toEqual(["publish", ...PUBLISH_OPTIONS]);
    expect(buildNpmPublishArguments()).toEqual(["publish", ...PUBLISH_OPTIONS]);
  });

  it("prefixes a nested relative artifact so npm reads it as a file instead of a package spec", () => {
    expect(buildNpmPublishArguments("releases/1.9.0-abc/pkg-1.9.0.tgz")).toEqual([
      "publish",
      "./releases/1.9.0-abc/pkg-1.9.0.tgz",
      ...PUBLISH_OPTIONS,
    ]);
  });

  it("prefixes an artifact at the repository root", () => {
    expect(buildNpmPublishArguments("pkg-1.9.0.tgz")).toEqual(["publish", "./pkg-1.9.0.tgz", ...PUBLISH_OPTIONS]);
  });

  it("keeps an artifact that is already explicitly relative", () => {
    expect(buildNpmPublishArguments("./releases/pkg-1.9.0.tgz")).toEqual(["publish", "./releases/pkg-1.9.0.tgz", ...PUBLISH_OPTIONS]);
  });
});
