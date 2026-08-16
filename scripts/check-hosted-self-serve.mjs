import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateOrigin(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.origin !== value
    ) {
      throw new Error("invalid_hosted_origin");
    }
    return parsed.origin;
  } catch {
    throw new Error("invalid_hosted_origin");
  }
}

export async function runHostedSelfServeChecks({
  webOrigin: webOriginInput,
  apiOrigin: apiOriginInput,
  mode = "external-api",
  fetchImpl = globalThis.fetch,
  writeLine = (line) => process.stdout.write(`${line}\n`),
}) {
  const webOrigin = validateOrigin(webOriginInput);
  if (mode !== "external-api" && mode !== "embedded") {
    throw new Error("invalid_hosted_mode");
  }
  const apiOrigin =
    mode === "external-api" ? validateOrigin(apiOriginInput) : undefined;
  const checks = [
    ["web_live", new URL("/health/live", webOrigin), 200, '"status":"ok"'],
    ["web_ready", new URL("/health/ready", webOrigin), 200, '"status":"ok"'],
    ...(apiOrigin === undefined
      ? []
      : [
          [
            "api_live",
            new URL("/health/live", apiOrigin),
            200,
            '"status":"ok"',
          ],
          [
            "api_ready",
            new URL("/health/ready", apiOrigin),
            200,
            '"status":"ok"',
          ],
        ]),
    ["try_page", new URL("/try", webOrigin), 200, "Use a public wallet"],
    ...(mode === "embedded"
      ? [
          [
            "public_wallet_analysis",
            new URL("/v1/public-wallet-analysis", webOrigin),
            200,
            '"schemaVersion":"0.1"',
            {
              method: "POST",
              headers: {
                origin: webOrigin,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                walletAddress: "LcNR2RPX9mMG1a23dfG6yQNvLUctx4sniKXKH9TV3ym",
                rangeDays: 7,
              }),
            },
          ],
        ]
      : []),
  ];

  for (const [name, url, expectedStatus, expectedText, requestInit] of checks) {
    let response;
    try {
      response = await fetchImpl(url, {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
        ...requestInit,
      });
    } catch {
      throw checkFailure(name, "request_failed");
    }
    if (response.status !== expectedStatus) {
      throw checkFailure(name, `status_${response.status}`);
    }
    let body;
    try {
      body = await response.text();
    } catch {
      throw checkFailure(name, "unreadable_response");
    }
    if (!body.includes(expectedText)) {
      throw checkFailure(name, "unexpected_response");
    }
    writeLine(`PASS ${name}`);
  }
}

function checkFailure(name, reason) {
  return new Error(`hosted_self_serve_check_failed:${name}:${reason}`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await runHostedSelfServeChecks({
      webOrigin: process.env.PAYOPS_WEB_ORIGIN,
      apiOrigin: process.env.PAYOPS_PUBLIC_API_ORIGIN,
      mode: process.env.PAYOPS_HOSTED_SELF_SERVE_MODE ?? "external-api",
    });
  } catch (error) {
    const message =
      error instanceof Error &&
      /^(invalid_hosted_origin|invalid_hosted_mode|hosted_self_serve_check_failed:)/.test(
        error.message,
      )
        ? error.message
        : "hosted_self_serve_check_failed";
    process.stderr.write(`FAIL ${message}\n`);
    process.exitCode = 1;
  }
}
