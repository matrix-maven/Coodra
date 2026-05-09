'use client';

import { useState } from 'react';

import { CheckIcon, CopyIcon } from '@/components/ui';

/**
 * `apps/web/components/CopyButton.tsx` — small inline copy-to-clipboard
 * button. Shows a check icon for ~1.5s after a successful copy.
 */

export interface CopyButtonProps {
  readonly value: string;
  readonly label?: string;
  readonly className?: string;
}

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may be blocked; silently no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ?? `Copy ${value}`}
      className={`flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-elevated hover:text-text-primary ${
        className ?? ''
      }`}
    >
      {copied ? <CheckIcon className="h-3.5 w-3.5 text-status-success" /> : <CopyIcon className="h-3.5 w-3.5" />}
    </button>
  );
}
