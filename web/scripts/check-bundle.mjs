import { resolve } from "node:path";

import { formatBytes, inspectClientBundle } from "./bundle-budget.mjs";

const report = await inspectClientBundle(resolve(process.cwd(), "dist"));

console.log("Client bundle attribution (raw / gzip):");
for (const chunk of report.chunks) {
  const rationale = chunk.reason ? `; ${chunk.reason}` : "";
  console.log(
    `- ${chunk.owner}: ${chunk.filename} ${formatBytes(chunk.raw)} / ${formatBytes(chunk.gzip)}`
      + ` (budget ${formatBytes(chunk.rawBudget)} / ${formatBytes(chunk.gzipBudget)}${rationale})`,
  );
}

if (report.issues.length > 0) {
  console.error("Bundle budgets failed:");
  for (const issue of report.issues) console.error(`- ${issue.chunk.filename}: ${issue.message}`);
  process.exitCode = 1;
} else {
  console.log("Bundle budgets passed.");
}

