import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  analyzeArchitecture,
  checkRepositoryArchitecture,
} from "../scripts/architecture-rules.mjs";

async function withFixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "super-idol-architecture-"));
  try {
    await Promise.all(Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, source, "utf8");
    }));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("shared modules cannot depend on a feature", async () => {
  await withFixture({
    "app/studio/shared/query.ts": 'import { useRuns } from "../features/runs/index";\n',
    "app/studio/features/runs/index.ts": "export const useRuns = 1;\n",
  }, async (root) => {
    const issues = await analyzeArchitecture(root);
    assert.deepEqual(issues.map((issue) => issue.rule), ["shared-to-feature"]);
  });
});

test("path aliases cannot bypass shared dependency rules", async () => {
  await withFixture({
    "app/studio/shared/query.ts": 'import { useRuns } from "@/app/studio/features/runs";\n',
    "app/studio/features/runs/index.ts": "export const useRuns = 1;\n",
  }, async (root) => {
    const issues = await analyzeArchitecture(root);
    assert.deepEqual(issues.map((issue) => issue.rule), ["shared-to-feature"]);
  });
});

test("features may cross a sibling seam only through its public index", async () => {
  await withFixture({
    "app/studio/features/runs/useRuns.ts": [
      'import { publicAsset } from "../assets";',
      'import { privateAsset } from "../assets/internal/privateAsset";',
    ].join("\n"),
    "app/studio/features/assets/index.ts": "export const publicAsset = 1;\n",
    "app/studio/features/assets/internal/privateAsset.ts": "export const privateAsset = 1;\n",
  }, async (root) => {
    const issues = await analyzeArchitecture(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].rule, "feature-private-import");
    assert.match(issues[0].message, /assets/);
  });
});

test("presentation and composition modules cannot call fetch directly", async () => {
  await withFixture({
    "app/studio/features/assets/AssetPreview.tsx": "export async function AssetPreview() { return fetch('/api/assets'); }\n",
    "app/studio/features/assets/AssetQuery.tsx": "export async function AssetQuery() { return fetch('/api/assets'); }\n",
    "app/studio/features/assets/assets-api.ts": "export async function loadAssets() { return fetch('/api/assets'); }\n",
  }, async (root) => {
    const issues = await analyzeArchitecture(root);
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.map((issue) => issue.rule), [
      "direct-network-in-presentation",
      "direct-network-in-presentation",
    ]);
  });
});

test("composition roots import feature public interfaces, not private files", async () => {
  await withFixture({
    "app/studio/StudioApplication.tsx": [
      'import { useRuns } from "./features/runs";',
      'import { privateRunState } from "./features/runs/internal/privateRunState";',
    ].join("\n"),
    "app/studio/features/runs/index.ts": "export const useRuns = 1;\n",
    "app/studio/features/runs/internal/privateRunState.ts": "export const privateRunState = 1;\n",
  }, async (root) => {
    const issues = await analyzeArchitecture(root);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].rule, "composition-private-import");
  });
});

test("the repository conforms to the executable architecture rules", async () => {
  const issues = await checkRepositoryArchitecture();
  assert.deepEqual(issues, []);
});
