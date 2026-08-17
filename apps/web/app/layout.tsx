import "@fontsource-variable/archivo/wdth.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../styles/tokens.css";
import "../styles/checkout.css";
import "../styles/operations.css";
import "../styles/try.css";
import "../styles/marketing.css";
import "../styles/docs.css";
import "../styles/trust-pages.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { resolvePublicWebOrigin } from "../lib/public-origin";

const webOrigin = resolvePublicWebOrigin(process.env.PAYOPS_WEB_ORIGIN);

export const metadata: Metadata = {
  metadataBase: new URL(webOrigin),
  title: { default: "PayOps", template: "%s | PayOps" },
  description:
    "Open Solana stablecoin payment verification and reconciliation infrastructure.",
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#f3f5f2",
};

export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
