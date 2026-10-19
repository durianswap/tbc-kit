import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function repositoryRoot(importMetaUrl) {
  let current = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    const hasProtocolRoots = ["schemas", "registry", "standards"].every(
      (directory) => fs.statSync(path.join(current, directory), {
        throwIfNoEntry: false,
      })?.isDirectory(),
    );
    if (hasProtocolRoots) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot locate TWS repository root from ${importMetaUrl}`);
    }
    current = parent;
  }
}

export function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

export function listFiles(root, directory, extension) {
  return fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => ({
      absolutePath: path.join(root, directory, entry.name),
      relativePath: `${directory}/${entry.name}`,
    }))
    .sort((left, right) =>
      left.relativePath < right.relativePath
        ? -1
        : left.relativePath > right.relativePath
          ? 1
          : 0,
    );
}
