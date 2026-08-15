const githubUrl = "https://github.com/GautamBytes/solana-payment-ops";

export const marketingDestinations = {
  docsUrl: "/docs",
  integrationUrl: "/docs/integration",
  packagesUrl: "/docs/packages",
  securityUrl: "/docs/security",
  apiUrl: "/docs/api",
  githubUrl,
  talkUrl:
    `${githubUrl}/issues/new?title=Question%20about%20PayOps&body=` +
    "What%20would%20you%20like%20to%20know%20about%20PayOps%3F",
  pilotUrl:
    `${githubUrl}/issues/new?title=PayOps%20read-only%20pilot&body=` +
    "Tell%20us%20about%20your%20Solana%20payment%20flow%20and%20what%20you%20want%20to%20reconcile.",
} as const;
