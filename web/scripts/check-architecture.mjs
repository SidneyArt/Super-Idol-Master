import { checkRepositoryArchitecture } from "./architecture-rules.mjs";

const issues = await checkRepositoryArchitecture();

if (issues.length > 0) {
  console.error("Architecture checks failed:");
  for (const issue of issues) {
    console.error(`- ${issue.path}:${issue.line} [${issue.rule}] ${issue.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("Architecture checks passed.");
}
