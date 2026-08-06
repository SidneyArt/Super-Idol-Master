import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test-results",
]);

const DEFAULT_COMPOSITION_IMPORT_EXCEPTIONS = new Set();

// These two server-render bootstrap reads predate the query modules. The
// fingerprints keep the exception narrow: another fetch in page.tsx still
// fails, while removing either legacy read needs no checker change.
const DEFAULT_NETWORK_EXCEPTIONS = [
  {
    path: "app/page.tsx",
    fingerprint: "fetch(`${API_BASE}/api/runs`",
    maxOccurrences: 1,
  },
  {
    path: "app/page.tsx",
    fingerprint: "fetch(`${API_BASE}/api/workspaces`",
    maxOccurrences: 1,
  },
];

const defaultWebRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function toPosix(path) {
  return path.split(sep).join("/");
}

async function collectSourceFiles(root) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(path);
      }
    }));
  }

  await visit(root);
  return files.sort();
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function importsIn(source) {
  const imports = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.push({ offset: match.index, specifier: match[1] });
    }
  }
  return imports.sort((left, right) => left.offset - right.offset);
}

function featureLocation(path) {
  const parts = toPosix(path).split("/");
  const featuresIndex = parts.lastIndexOf("features");
  if (featuresIndex < 0 || !parts[featuresIndex + 1]) return null;
  return {
    feature: parts[featuresIndex + 1],
    rest: parts.slice(featuresIndex + 2),
  };
}

function isPublicFeatureTarget(target) {
  const location = featureLocation(target);
  if (!location) return false;
  if (location.rest.length === 0) return true;
  return location.rest.length === 1 && /^index(?:\.[^.]+)?$/.test(location.rest[0]);
}

function isShared(path) {
  return toPosix(path).split("/").includes("shared");
}

function isCompositionRoot(path) {
  const normalized = toPosix(path);
  return normalized === "app/page.tsx"
    || normalized === "app/Studio.tsx"
    || normalized === "app/studio/StudioApplication.tsx"
    || /\/(?:HomeScreen|TaskScreen|StudioNavigation)\.(?:jsx?|tsx?)$/.test(normalized);
}

function isNetworkAdapter(path) {
  const normalized = toPosix(path);
  if (!normalized.startsWith("app/")) return true;
  const filename = normalized.split("/").at(-1) || "";
  if (/\.(?:jsx|tsx)$/.test(filename)) return false;
  const stem = filename.replace(/\.[^.]+$/, "");
  return /(?:^|[-.])(api|client|gateway|query|repository)(?:$|[-.])/i.test(stem);
}

function targetPath(root, importer, specifier) {
  if (specifier.startsWith("@/")) return toPosix(specifier.slice(2));
  if (!specifier.startsWith(".")) return null;
  return toPosix(relative(root, resolve(dirname(resolve(root, importer)), specifier)));
}

function consumeNetworkException(exceptions, path, source, offset, counts) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  for (const exception of exceptions) {
    if (exception.path !== path || !line.includes(exception.fingerprint)) continue;
    const key = `${exception.path}::${exception.fingerprint}`;
    const nextCount = (counts.get(key) || 0) + 1;
    counts.set(key, nextCount);
    return nextCount <= exception.maxOccurrences;
  }
  return false;
}

export async function analyzeArchitecture(root, options = {}) {
  const compositionImportExceptions = options.compositionImportExceptions || new Set();
  const networkExceptions = options.networkExceptions || [];
  const networkExceptionCounts = new Map();
  const issues = [];
  const files = await collectSourceFiles(root);

  for (const absolutePath of files) {
    const path = toPosix(relative(root, absolutePath));
    const source = await readFile(absolutePath, "utf8");
    const importerFeature = featureLocation(path);

    for (const imported of importsIn(source)) {
      const target = targetPath(root, path, imported.specifier);
      if (!target) continue;
      const targetFeature = featureLocation(target);
      const issueBase = { path, line: lineAt(source, imported.offset) };

      if (isShared(path) && targetFeature) {
        issues.push({
          ...issueBase,
          rule: "shared-to-feature",
          message: `shared module imports business feature '${targetFeature.feature}'`,
        });
        continue;
      }

      if (importerFeature && targetFeature
        && importerFeature.feature !== targetFeature.feature
        && !isPublicFeatureTarget(target)) {
        issues.push({
          ...issueBase,
          rule: "feature-private-import",
          message: `feature '${importerFeature.feature}' imports private implementation of '${targetFeature.feature}'; import its public index instead`,
        });
        continue;
      }

      const exceptionKey = `${path}::${imported.specifier}`;
      if (isCompositionRoot(path) && targetFeature && !isPublicFeatureTarget(target)
        && !compositionImportExceptions.has(exceptionKey)) {
        issues.push({
          ...issueBase,
          rule: "composition-private-import",
          message: `composition root imports private implementation of '${targetFeature.feature}'; import its public index instead`,
        });
      }
    }

    if (!isNetworkAdapter(path)) {
      for (const match of source.matchAll(/\bfetch\s*\(/g)) {
        if (consumeNetworkException(networkExceptions, path, source, match.index, networkExceptionCounts)) continue;
        issues.push({
          path,
          line: lineAt(source, match.index),
          rule: "direct-network-in-presentation",
          message: "presentation/composition module calls fetch directly; move the request behind a feature query or API adapter",
        });
      }
    }
  }

  return issues.sort((left, right) => left.path.localeCompare(right.path)
    || left.line - right.line
    || left.rule.localeCompare(right.rule));
}

export async function checkRepositoryArchitecture(root = defaultWebRoot) {
  return analyzeArchitecture(root, {
    compositionImportExceptions: DEFAULT_COMPOSITION_IMPORT_EXCEPTIONS,
    networkExceptions: DEFAULT_NETWORK_EXCEPTIONS,
  });
}
