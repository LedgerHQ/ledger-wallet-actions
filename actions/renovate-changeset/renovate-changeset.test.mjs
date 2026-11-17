import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChangeset, diffImporters, parseImporters } from "./renovate-changeset.mjs";

const lockfile = ({ lib = "1.0.0", dev = "2.0.0", app = "3.0.0" } = {}) => `---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@changesets/cli':
        specifier: ^3.0.3
        version: 3.0.3(@types/node@26.6.6)

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      typescript:
        specifier: 'catalog:'
        version: 7.0.2

  apps/desktop:
    dependencies:
      '@scope/lib':
        specifier: workspace:*
        version: link:../../libs/lib
    devDependencies:
      bundler:
        specifier: ^${app}
        version: ${app}(peer@1.0.0)

  libs/empty: {}

  libs/lib:
    dependencies:
      ws:
        specifier: 'catalog:'
        version: ${lib}
    devDependencies:
      jest:
        specifier: ^${dev}
        version: ${dev}
    dependenciesMeta:
      ws:
        injected: true

packages:

  ws@${lib}:
    resolution: {integrity: sha512-x}
`;

const packages = {
  "apps/desktop": { name: "desktop", version: "1.0.0" },
  "libs/lib": { name: "@scope/lib", version: "1.0.0" },
};
const readPackage = dir => packages[dir];

describe("parseImporters", () => {
  it("reads the last YAML document and skips non-dependency sections", () => {
    assert.deepEqual(parseImporters(lockfile())["libs/lib"], {
      dependencies: { ws: { specifier: "catalog:", version: "1.0.0" } },
      devDependencies: { jest: { specifier: "^2.0.0", version: "2.0.0" } },
    });
  });

  it("keeps importers without dependencies", () => {
    assert.deepEqual(parseImporters(lockfile())["libs/empty"], {});
  });

  it("fails on multi-line scalars instead of misreading them", () => {
    assert.throws(() => parseImporters(lockfile({ lib: ">-" })), /multi-line/);
  });

  it("rejects lockfiles older than format 6, whose versions sit on the dependency line", () => {
    assert.throws(() => parseImporters("lockfileVersion: 5.4\n\nimporters:\n\n  .:\n    dependencies:\n      ws: 1.0.0\n"), /lockfileVersion: 5/);
  });

  it("unquotes single-quoted keys", () => {
    assert.ok(parseImporters(lockfile())["apps/desktop"].dependencies["@scope/lib"]);
  });
});

describe("diffImporters", () => {
  it("reports changed sections and new versions without peer suffix", () => {
    const changes = diffImporters(parseImporters(lockfile()), parseImporters(lockfile({ app: "3.1.0" })));
    assert.deepEqual([...changes.keys()], ["apps/desktop"]);
    assert.deepEqual([...changes.get("apps/desktop").sections], ["devDependencies"]);
    assert.deepEqual([...changes.get("apps/desktop").updates], [["bundler", "3.1.0"]]);
  });

  it("returns nothing when importers are unchanged", () => {
    assert.equal(diffImporters(parseImporters(lockfile()), parseImporters(lockfile())).size, 0);
  });
});

describe("buildChangeset", () => {
  const build = (versions, options = {}) =>
    buildChangeset({
      changes: diffImporters(parseImporters(lockfile()), parseImporters(lockfile(versions))),
      readPackage,
      title: "chore(deps): update",
      ...options,
    });

  it("bumps a library on a runtime dependency update", () => {
    assert.equal(
      build({ lib: "1.1.0" }).content,
      '---\n"@scope/lib": patch\n---\n\nchore(deps): update\n\n- Updated `ws` to `1.1.0`\n',
    );
  });

  it("ignores devDependency-only updates of libraries", () => {
    assert.equal(build({ dev: "2.1.0" }).content, undefined);
  });

  it("bumps bundled packages on devDependency updates, as minor when listed", () => {
    const { packages: released, content } = build(
      { app: "3.1.0" },
      { bundledPaths: ["apps/"], minorPackages: ["desktop"] },
    );
    assert.deepEqual(released, ["desktop"]);
    assert.match(content, /^---\n"desktop": minor\n---/);
  });

  it("matches a bundled directory given with a trailing slash", () => {
    assert.equal(build({ app: "3.1.0" }, { bundledPaths: ["apps/desktop/"] }).packages[0], "desktop");
  });

  it("matches bundled paths on whole directory names", () => {
    assert.equal(build({ app: "3.1.0" }, { bundledPaths: ["app"] }).content, undefined);
  });
});
