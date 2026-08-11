const platform = await import("@payops/platform");

if (typeof platform.runMigrationSet !== "function") {
  throw new Error("@payops/platform migration entrypoint is unavailable");
}
