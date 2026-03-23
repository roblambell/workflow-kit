// ci-failures command: show failing CI check details for a PR.

import { die } from "../output.ts";
import { prChecks } from "../gh.ts";

export function cmdCiFailures(
  args: string[],
  projectRoot: string,
): void {
  const prNumber = args[0] ?? "";
  if (!prNumber) die("Usage: ninthwave ci-failures <PR_NUMBER>");

  const checks = prChecks(projectRoot, parseInt(prNumber, 10));
  const failures = checks.filter((c) => c.state === "FAILURE");

  if (failures.length === 0) {
    console.log("No failing checks found");
    return;
  }

  for (const check of failures) {
    console.log(`${check.name}\t${check.url}`);
  }
}
