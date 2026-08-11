#!/usr/bin/env node
import { stringifyCanonical } from "./canonical-json.js";
import { evaluateConformancePath } from "./conformance.js";
import { resolveFixturePath } from "./resolve-fixture-path.js";

async function main(args: readonly string[]): Promise<number> {
  const [fixtureArgument, unexpectedArgument] = args;
  if (fixtureArgument === undefined || unexpectedArgument !== undefined) {
    process.stderr.write(
      "Usage: payops-conformance <payment-fixture-or-manifest.json>\n",
    );
    return 2;
  }

  try {
    const fixturePath = resolveFixturePath(
      fixtureArgument,
      process.env.INIT_CWD,
      process.cwd(),
    );
    const report = await evaluateConformancePath(fixturePath);
    process.stdout.write(stringifyCanonical(report));
    return report.passed ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown conformance error";
    process.stderr.write(`Conformance error: ${message}\n`);
    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
