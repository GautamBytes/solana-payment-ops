import { resolve } from "node:path";

export function resolveFixturePath(
  fixtureArgument: string,
  invokingDirectory: string | undefined,
  currentWorkingDirectory: string,
): string {
  return resolve(invokingDirectory ?? currentWorkingDirectory, fixtureArgument);
}
