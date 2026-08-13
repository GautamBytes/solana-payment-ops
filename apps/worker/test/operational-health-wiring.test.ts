import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("hosted worker operational health wiring", () => {
  it("runs scheduled producers and drains durable signals around normal jobs", async () => {
    const source = await readFile(
      new URL("../src/jobs.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("OperationalHealthStore");
    expect(source).toContain("enqueueScheduledSignals");
    expect(source).toContain("drainSignals");
    expect(source).toContain("#withOperationalHealth");
  });

  it("does not run production health maintenance for local or test RPC modes", async () => {
    const source = await readFile(
      new URL("../src/jobs.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'this.#rpc.mode !== "dual_provider" ||\n      this.#rpc.cluster !== "mainnet-beta"',
    );
  });
});
