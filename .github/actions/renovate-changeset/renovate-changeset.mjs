#!/usr/bin/env node
// Writes .changeset/<name>.md for the workspace packages whose dependencies changed in pnpm-lock.yaml since <base>.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

const unquote = raw => {
  const value = raw.trim();
  if (/^[>|]/.test(value)) throw new Error(`Unsupported multi-line YAML scalar: ${raw}`);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
};

// pnpm writes importers in a fixed shape; the last YAML document is the project lockfile (pnpm 11).
export function parseImporters(lockfile) {
  const documents = lockfile.split(/^---\r?$/m);
  const lines = documents[documents.length - 1].split(/\r?\n/);
  const version = lines.find(line => line.startsWith("lockfileVersion:"))?.match(/(\d+)(?:\.\d+)?/)?.[1];
  if (!version || Number(version) < 6) throw new Error(`Unsupported pnpm lockfileVersion: ${version ?? "none"} (needs 6+)`);
  const importers = {};
  const start = lines.indexOf("importers:");
  if (start === -1) return importers;
  let importer, section, dependency;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    const separator = line.indexOf(": ");
    const key = unquote(separator === -1 ? line.replace(/:\s*$/, "") : line.slice(0, separator));
    const value = separator === -1 ? undefined : unquote(line.slice(separator + 2));
    if (indent === 2) {
      importer = importers[key] = {};
      section = dependency = undefined;
    } else if (indent === 4) {
      section = DEPENDENCY_SECTIONS.has(key) ? (importer[key] = {}) : undefined;
      dependency = undefined;
    } else if (indent === 6 && section) {
      dependency = section[key] = {};
    } else if (indent === 8 && dependency && (key === "specifier" || key === "version")) {
      dependency[key] = value;
    }
  }
  return importers;
}

const stripPeers = version => version?.replace(/\(.*$/, "");

// Returns, per importer dir, the dependency sections that changed and the new versions.
export function diffImporters(base, head) {
  const changes = new Map();
  for (const [dir, headImporter] of Object.entries(head)) {
    const baseImporter = base[dir];
    if (!baseImporter) continue;
    for (const name of DEPENDENCY_SECTIONS) {
      const before = baseImporter[name] ?? {};
      const after = headImporter[name] ?? {};
      for (const dependency of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const lhs = before[dependency];
        const rhs = after[dependency];
        if (lhs?.specifier === rhs?.specifier && lhs?.version === rhs?.version) continue;
        const change = changes.get(dir) ?? { sections: new Set(), updates: new Map() };
        changes.set(dir, change);
        change.sections.add(name);
        const version = stripPeers(rhs?.version);
        if (version && !version.startsWith("link:") && version !== stripPeers(lhs?.version))
          change.updates.set(dependency, version);
      }
    }
  }
  return changes;
}

// Packages under a bundled path ship their devDependencies (apps); others only ship runtime deps.
export function buildChangeset({ changes, readPackage, title, minorPackages = [], bundledPaths = [] }) {
  const minor = new Set(minorPackages);
  const bundled = bundledPaths.map(path => path.replace(/\/+$/, ""));
  const released = [...changes]
    .filter(([dir]) => dir !== ".")
    .map(([dir, change]) => ({
      ...change,
      bundled: bundled.some(path => dir === path || dir.startsWith(`${path}/`)),
      pkg: readPackage(dir),
    }))
    .filter(({ pkg }) => pkg?.name && pkg.version)
    .filter(({ bundled, sections }) => bundled || [...sections].some(s => s !== "devDependencies"))
    .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
  if (released.length === 0) return { packages: [], content: undefined };
  const header = released.map(({ pkg }) => `"${pkg.name}": ${minor.has(pkg.name) ? "minor" : "patch"}`);
  const details = [
    ...new Set(
      released.flatMap(({ updates }) => [...updates]).map(([d, v]) => `- Updated \`${d}\` to \`${v}\``),
    ),
  ].sort();
  return {
    packages: released.map(({ pkg }) => pkg.name),
    content: `---\n${header.join("\n")}\n---\n\n${[title, "", ...details].join("\n").trim()}\n`,
  };
}

const list = value => (value ?? "").split(/[\n,]/).map(s => s.trim()).filter(Boolean);

function main() {
  const { BASE, NAME, TITLE, LOCKFILE = "pnpm-lock.yaml", CHANGESET_DIR = ".changeset" } = process.env;
  if (!BASE || !NAME || !TITLE) {
    console.error("BASE, NAME and TITLE are required");
    process.exit(1);
  }
  if (!/^[\w.-]+$/.test(NAME)) {
    console.error(`Invalid changeset name: ${NAME}`);
    process.exit(1);
  }
  const readLockfileAt = revision =>
    parseImporters(
      execFileSync("git", ["show", `${revision}:${LOCKFILE}`], { encoding: "utf8", maxBuffer: 1 << 30 }),
    );
  const root = LOCKFILE.includes("/") ? LOCKFILE.slice(0, LOCKFILE.lastIndexOf("/")) : ".";
  const { packages, content } = buildChangeset({
    changes: diffImporters(readLockfileAt(BASE), readLockfileAt("HEAD")),
    readPackage: dir => {
      const file = join(root, dir, "package.json");
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    },
    title: TITLE,
    minorPackages: list(process.env.MINOR_PACKAGES),
    bundledPaths: list(process.env.BUNDLED_PATHS),
  });
  const file = join(CHANGESET_DIR, `${NAME}.md`);
  if (content) {
    mkdirSync(CHANGESET_DIR, { recursive: true });
    writeFileSync(file, content);
    console.log(`${file}:\n${packages.join("\n")}`);
  } else {
    rmSync(file, { force: true });
    console.log("No workspace package changed.");
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
