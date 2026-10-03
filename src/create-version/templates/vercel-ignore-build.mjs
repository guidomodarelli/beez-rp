/** Gates Git deployments while an exact release is owned by CI. */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let delegated = false;
try {
  if (existsSync('.beez-rp/release.json')) {
    const metadata = JSON.parse(readFileSync('.beez-rp/release.json', 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    delegated = metadata.execution === 'ci' && metadata.version === manifest.version;
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
