import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "build");
mkdirSync(output, { recursive: true });

for (const file of ["product-facts.v1.json", "product-facts.v1.sha256"]) {
  copyFileSync(resolve(root, "src", file), resolve(output, file));
}
