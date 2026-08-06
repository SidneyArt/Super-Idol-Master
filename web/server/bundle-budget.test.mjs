import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectClientBundle } from "../scripts/bundle-budget.mjs";

async function withBundle(files, manifest, run) {
  const root = await mkdtemp(join(tmpdir(), "super-idol-bundle-"));
  try {
    await mkdir(join(root, "client", "assets"), { recursive: true });
    await mkdir(join(root, "client", ".vite"), { recursive: true });
    await writeFile(join(root, "client", ".vite", "manifest.json"), JSON.stringify(manifest));
    await Promise.all(Object.entries(files).map(([name, source]) => (
      writeFile(join(root, "client", "assets", name), source)
    )));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bundle report attributes a manifest chunk to its stable owner", async () => {
  await withBundle(
    { "vendor-three-hash.js": "export const three = true;" },
    { three: { file: "assets/vendor-three-hash.js", name: "vendor-three" } },
    async (root) => {
      const report = await inspectClientBundle(root);
      assert.equal(report.issues.length, 0);
      assert.equal(report.chunks[0].owner, "Three.js 3D preview runtime");
    },
  );
});

test("bundle report fails an unattributed chunk over the default budget", async () => {
  await withBundle(
    { "mystery-hash.js": "x".repeat(250_001) },
    {},
    async (root) => {
      const report = await inspectClientBundle(root);
      assert.equal(report.issues.length, 1);
      assert.match(report.issues[0].message, /raw 250001 > 250000/);
    },
  );
});

