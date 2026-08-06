import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const CLIENT_BUNDLE_BUDGETS = {
  "vendor-three": {
    owner: "Three.js 3D preview runtime",
    raw: 760_000,
    gzip: 200_000,
    reason: "tree-shaken Three.js core and examples used only by the lazy ModelViewer entry",
  },
  "vendor-react": {
    owner: "React/Vinext shared runtime",
    raw: 225_000,
    gzip: 70_000,
  },
  "vendor-markdown": {
    owner: "Agent Markdown renderer",
    raw: 180_000,
    gzip: 60_000,
  },
  Studio: {
    owner: "Studio application code",
    raw: 250_000,
    gzip: 70_000,
  },
  ModelViewer: {
    owner: "ModelViewer application code",
    raw: 80_000,
    gzip: 25_000,
  },
  index: {
    owner: "Vinext browser entry",
    raw: 120_000,
    gzip: 40_000,
  },
  styles: {
    owner: "Application styles",
    raw: 200_000,
    gzip: 45_000,
  },
  default: {
    owner: "Unattributed client chunk",
    raw: 250_000,
    gzip: 80_000,
  },
};

function manifestNames(manifest) {
  const names = new Map();
  for (const entry of Object.values(manifest)) {
    if (entry.file && entry.name) names.set(entry.file, entry.name);
  }
  return names;
}

export async function inspectClientBundle(distRoot, budgets = CLIENT_BUNDLE_BUDGETS) {
  const clientRoot = resolve(distRoot, "client");
  const assetsRoot = resolve(clientRoot, "assets");
  const manifest = JSON.parse(await readFile(resolve(clientRoot, ".vite", "manifest.json"), "utf8"));
  const names = manifestNames(manifest);
  const assetNames = await readdir(assetsRoot);
  const chunks = [];

  for (const filename of assetNames.sort()) {
    if (!/\.(?:css|js)$/.test(filename)) continue;
    const file = resolve(assetsRoot, filename);
    const raw = (await stat(file)).size;
    const gzip = gzipSync(await readFile(file)).byteLength;
    const manifestName = names.get(`assets/${filename}`);
    const name = filename.endsWith(".css") ? "styles" : (manifestName || "default");
    const budget = budgets[name] || budgets.default;
    chunks.push({
      filename,
      name,
      owner: budget.owner,
      raw,
      gzip,
      rawBudget: budget.raw,
      gzipBudget: budget.gzip,
      reason: budget.reason || null,
    });
  }

  chunks.sort((left, right) => right.raw - left.raw || left.filename.localeCompare(right.filename));
  const issues = chunks.flatMap((chunk) => {
    const exceeded = [];
    if (chunk.raw > chunk.rawBudget) exceeded.push(`raw ${chunk.raw} > ${chunk.rawBudget}`);
    if (chunk.gzip > chunk.gzipBudget) exceeded.push(`gzip ${chunk.gzip} > ${chunk.gzipBudget}`);
    return exceeded.length ? [{ chunk, message: exceeded.join(", ") }] : [];
  });
  return { chunks, issues };
}

export function formatBytes(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

