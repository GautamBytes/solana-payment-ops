export interface PublicAnalysisCompletion {
  readonly event: "public_analysis_request_completed";
  readonly requestId: string;
  readonly route: "/v1/public-wallet-analysis";
  readonly statusClass: "2xx" | "4xx" | "5xx";
  readonly durationMs: number;
  readonly code: string;
}

export function serializePublicAnalysisCompletion(
  completion: PublicAnalysisCompletion,
): string {
  return JSON.stringify({
    level: "info",
    service: "web",
    ...completion,
    durationMs: Math.min(
      30_000,
      Math.max(0, Math.round(completion.durationMs)),
    ),
  });
}

export function writePublicAnalysisCompletion(
  completion: PublicAnalysisCompletion,
): void {
  process.stdout.write(`${serializePublicAnalysisCompletion(completion)}\n`);
}

export function publicAnalysisStatusClass(
  status: number,
): PublicAnalysisCompletion["statusClass"] {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "2xx";
}
