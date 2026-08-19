const githubUrl = "https://github.com/payops-labs/solana-payment-ops";

function resolveStatusUrl(value: string | undefined): string {
  if (value === undefined) return "/health/ready";
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("invalid_status_url");
    }
    return parsed.toString();
  } catch {
    throw new Error("invalid_status_url");
  }
}

export const marketingDestinations = {
  docsUrl: "/docs",
  integrationUrl: "/docs/integration",
  packagesUrl: "/docs/packages",
  securityUrl: "/docs/security",
  apiUrl: "/docs/api",
  tryUrl: "/try",
  aboutUrl: "/about",
  roadmapUrl: "/roadmap",
  statusUrl: resolveStatusUrl(process.env.NEXT_PUBLIC_PAYOPS_STATUS_URL),
  changelogUrl: `${githubUrl}/blob/main/CHANGELOG.md`,
  projectStatusUrl: `${githubUrl}/blob/main/PROJECT_STATUS.md`,
  walkthroughUrl: `${githubUrl}/blob/main/docs/project-walkthrough.md`,
  securityPolicyUrl: `${githubUrl}/blob/main/SECURITY.md`,
  supportUrl: `${githubUrl}/blob/main/SUPPORT.md`,
  githubUrl,
  talkUrl:
    `${githubUrl}/issues/new?title=Question%20about%20PayOps&body=` +
    "What%20would%20you%20like%20to%20know%20about%20PayOps%3F",
} as const;
