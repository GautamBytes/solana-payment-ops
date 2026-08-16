const githubUrl = "https://github.com/GautamBytes/solana-payment-ops";

export const marketingDestinations = {
  docsUrl: "/docs",
  integrationUrl: "/docs/integration",
  packagesUrl: "/docs/packages",
  securityUrl: "/docs/security",
  apiUrl: "/docs/api",
  tryUrl: "/try",
  githubUrl,
  talkUrl:
    `${githubUrl}/issues/new?title=Question%20about%20PayOps&body=` +
    "What%20would%20you%20like%20to%20know%20about%20PayOps%3F",
} as const;
