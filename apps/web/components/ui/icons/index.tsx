/**
 * `apps/web/components/ui/icons/index.tsx` — Heroicons-style 16/20px
 * inline SVG icons (M04 Phase 2 UI).
 *
 * Replaces the ~30 emoji glyphs sprinkled across pages
 * (✓ ✕ ▸ ▾ ◂ ⚠ ↻ ●). All icons are drawn at viewBox 24×24 and accept
 * `className` (defaults to `h-4 w-4`). Fill is `currentColor` so they
 * inherit text color from the parent element — buttons, banners, and
 * status dots compose naturally.
 *
 * Why one file: 8 small components, one import path, one source of
 * sizing / stroke truth. Adding a new icon = a single new function.
 */

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const DEFAULT_CLASS = 'h-4 w-4';

function svg(path: React.ReactNode, props: IconProps): React.ReactElement {
  const { className, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? DEFAULT_CLASS}
      {...rest}
    >
      {path}
    </svg>
  );
}

export const CheckIcon = (p: IconProps) => svg(<polyline points="20 6 9 17 4 12" />, p);

export const XIcon = (p: IconProps) =>
  svg(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    p,
  );

export const ChevronRightIcon = (p: IconProps) => svg(<polyline points="9 18 15 12 9 6" />, p);

export const ChevronDownIcon = (p: IconProps) => svg(<polyline points="6 9 12 15 18 9" />, p);

export const ArrowLeftIcon = (p: IconProps) =>
  svg(
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </>,
    p,
  );

export const AlertTriangleIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    p,
  );

export const RefreshIcon = (p: IconProps) =>
  svg(
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>,
    p,
  );

export const InfoIcon = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>,
    p,
  );

export const CircleIcon = (p: IconProps) => svg(<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />, p);

export const PlusIcon = (p: IconProps) =>
  svg(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
    p,
  );

export const DownloadIcon = (p: IconProps) =>
  svg(
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>,
    p,
  );

export const SearchIcon = (p: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    p,
  );

export const TrashIcon = (p: IconProps) =>
  svg(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>,
    p,
  );
