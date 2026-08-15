"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { useState } from "react";

const command = "npm install @payops/sdk";

export function SdkCopy() {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="sdk-command">
      <code>{command}</code>
      <button
        type="button"
        aria-label="Copy SDK install command"
        onClick={copyCommand}
      >
        {copied ? (
          <Check size={17} aria-hidden="true" />
        ) : (
          <Copy size={17} aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Install command copied" : ""}
      </span>
    </div>
  );
}
