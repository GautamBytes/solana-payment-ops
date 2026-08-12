import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Payment operations | PayOps",
  description:
    "Review Solana payment exceptions and produce accounting evidence.",
};

export default function OperationsLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return children;
}
