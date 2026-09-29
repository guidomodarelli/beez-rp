/**
 * Release version rules shared by `create-version` and the Vercel build gate.
 *
 * @module constants/versions
 */

/** Semver release types, from the smallest to the largest change. */
export const RELEASE_TYPE = Object.freeze({
  patch: "patch",
  minor: "minor",
  major: "major",
});

/**
 * Suggested release type before `1.0.0` with `preMajorShift`: one level down, the `0.x` convention
 * where a minor carries breaking changes and a patch carries features (release-please's
 * `bump-minor-pre-major` plus `bump-patch-for-minor-pre-major`).
 */
export const PRE_MAJOR_SHIFTED_RELEASE_TYPE = Object.freeze({
  patch: RELEASE_TYPE.patch,
  minor: RELEASE_TYPE.patch,
  major: RELEASE_TYPE.minor,
});

/** Major version of the `0.x` line, where `preMajorShift` applies. */
export const PRE_MAJOR_VERSION = 0;

/** Release types in the order they are offered: patch, minor, major. */
export const RELEASE_TYPE_ORDER = Object.freeze([RELEASE_TYPE.patch, RELEASE_TYPE.minor, RELEASE_TYPE.major]);

/** Stable `X.Y.Z` release version: no prerelease, build metadata, prefix or leading zeros. */
export const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Any semver version, capturing its `X.Y.Z` core and optional prerelease. */
export const SEMVER_PATTERN = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Prefix of the annotated Git tags that mark each release (`v0.93.0`). */
export const RELEASE_TAG_PREFIX = "v";

/** `git log --grep` pattern of release commit subjects (`0.93.0`). */
export const RELEASE_COMMIT_SUBJECT_GREP = String.raw`^[0-9]+\.[0-9]+\.[0-9]+$`;

/** Conventional commit header: `type(scope)!: subject`. */
export const CONVENTIONAL_HEADER_PATTERN = /^(?<type>[a-z]+)(?:\([^)]*\))?(?<breaking>!)?:\s/i;

/** Footer that marks a breaking change in a conventional commit body. */
export const BREAKING_CHANGE_FOOTER_PATTERN = /^BREAKING[ -]CHANGE:/m;

/** Conventional commit type that ships user-visible features. */
export const FEATURE_COMMIT_TYPE = "feat";

/** Imperative verbs used by legacy, non-conventional feature subjects. */
export const LEGACY_FEATURE_SUBJECT_PATTERN = /^(add|implement|introduce|support|enable|create|allow)\b/i;
