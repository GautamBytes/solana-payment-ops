import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  ...(process.env.VERCEL === "1" ? {} : { output: "standalone" }),
};

export default config;
