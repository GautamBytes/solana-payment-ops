const pilot = await import("@payops/pilot");

if (typeof pilot.runPilotMigrations !== "function") {
  throw new Error("@payops/pilot native ESM export is unavailable");
}
if (
  typeof pilot.runCli !== "function" ||
  typeof pilot.createShadowAuditRunner !== "function" ||
  typeof pilot.buildAuditArtifacts !== "function"
) {
  throw new Error("@payops/pilot public workflow exports are unavailable");
}
