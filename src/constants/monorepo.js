/**
 * Monorepo mode of `beez-rp create-version`: workspace discovery, per-package
 * tags and the subject of the single release commit.
 *
 * @module constants/monorepo
 */

/** `packages` value that releases the workspaces the root `package.json` declares. */
export const WORKSPACES_PACKAGES = "workspaces";

/** Placeholders of `tagFormat`. `{version}` is required. */
export const TAG_FORMAT_PLACEHOLDER = Object.freeze({
  version: "{version}",
  /** Last directory segment of the package (`packages/widget` → `widget`). */
  component: "{component}",
  /** npm name of the package (`@scope/widget`). */
  name: "{name}",
});

/** Tag of each package in monorepo mode: `widget-v1.2.0` (the release-please component tag). */
export const DEFAULT_MONOREPO_TAG_FORMAT = `${TAG_FORMAT_PLACEHOLDER.component}-v${TAG_FORMAT_PLACEHOLDER.version}`;

/**
 * Placeholder of `summary` replaced by the name of each released package in monorepo mode (next
 * to `{version}`, its version): a line with either one is printed once per released package.
 */
export const SUMMARY_PACKAGE_PLACEHOLDER = "{name}";

/** Prefix of the release commit subject: `release: @scope/a@1.2.0, @scope/b@0.3.1`. */
export const MONOREPO_RELEASE_SUBJECT_PREFIX = "release: ";

/** Separator of the released packages in the release commit subject. */
export const MONOREPO_RELEASE_ENTRY_SEPARATOR = ", ";

/** One `name@X.Y.Z` entry of the release commit subject; the name may be scoped. */
export const MONOREPO_RELEASE_ENTRY_PATTERN = /^(?<name>(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

/** Workspace pattern that matches every direct subdirectory: `packages/*`. */
export const WORKSPACE_WILDCARD_SUFFIX = "/*";

/** Prefix of a workspace pattern that excludes directories: `!packages/internal`. */
export const WORKSPACE_EXCLUSION_PREFIX = "!";

/** Manifest fields listing dependencies; any of them links workspace packages for change detection. */
export const DEPENDENCY_FIELDS = Object.freeze(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]);

/** Answer of the per-package version prompt that leaves the package out of this release. */
export const SKIP_PACKAGE_CHOICE = "skip";

/** Steps of a monorepo release plan (the shared ones reuse `RELEASE_STEP`). */
export const MONOREPO_RELEASE_STEP = Object.freeze({
  chooseVersions: "choose-versions",
  generateChangelogs: "generate-changelogs",
  bumpPackages: "bump-packages",
  pushPackages: "push-packages",
  publishPackages: "publish-packages",
});
