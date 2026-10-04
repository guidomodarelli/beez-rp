/**
 * Gates Git deployments while an exact release is owned by CI.
 *
 * A commit cannot contain its own SHA, so the release commit is identified as the one that
 * changes `.beez-rp/release.json` against its first parent; later commits keep the metadata
 * untouched and fall through to the original gate. Without a readable parent (shallow clone)
 * the release cannot be told apart, so the original gate decides as well.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE_METADATA_FILE = '.beez-rp/release.json';
/** `git diff --quiet` status reporting that the path changed between both commits. */
const GIT_DIFF_CHANGED_STATUS = 1;

/** @returns {boolean} Whether the deployed commit is the one that wrote the release metadata. */
function isReleaseMetadataCommit() {
  const changed = spawnSync('git', ['diff', '--quiet', 'HEAD^', 'HEAD', '--', RELEASE_METADATA_FILE], { stdio: 'ignore', windowsHide: true });
  return changed.status === GIT_DIFF_CHANGED_STATUS;
}

let delegated = false;
try {
  if (existsSync(RELEASE_METADATA_FILE)) {
    const metadata = JSON.parse(readFileSync(RELEASE_METADATA_FILE, 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    delegated = metadata.execution === 'ci' && metadata.version === manifest.version && isReleaseMetadataCommit();
  }
} catch {
  console.error('No se pudo leer la metadata del release; se omite el despliegue automático.');
  process.exit(0);
}
if (delegated) {
  console.log('El release está en CI; producción espera a que pasen los checks.');
  process.exit(0);
}
const originalIgnoreCommand = __ORIGINAL_IGNORE_COMMAND__;
process.exitCode = originalIgnoreCommand
  ? spawnSync(originalIgnoreCommand, { shell: true, stdio: 'inherit', windowsHide: true }).status ?? 0
  : 1;
