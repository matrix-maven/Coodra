/**
 * `apps/web/components/ui/index.ts` — barrel re-export for the M04
 * Phase 2 UI primitives library.
 *
 * Pages compose like:
 *   import { PageShell, PageHeader, Section, Card, Button, … } from '@/components/ui';
 */

export { Banner, type BannerKind, type BannerProps } from './Banner';
export { Breadcrumbs, type BreadcrumbsProps, type Crumb } from './Breadcrumbs';
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  IconButton,
  type IconButtonProps,
  LinkButton,
  type LinkButtonProps,
} from './Button';
export { Card, type CardProps } from './Card';
export {
  type CellAlign,
  Table,
  type TableProps,
  TBody,
  TD,
  type TDProps,
  TH,
  THead,
  type THProps,
  TR,
  type TRProps,
} from './DataTable';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { FormRow, type FormRowProps } from './FormRow';
export {
  Checkbox,
  type CheckboxProps,
  Input,
  type InputProps,
  Select,
  type SelectProps,
  Textarea,
  type TextareaProps,
} from './Input';
export {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  DownloadIcon,
  InfoIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from './icons';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { PageShell, type PageShellProps } from './PageShell';
export { Section, type SectionProps } from './Section';
export { StatusDot, type StatusDotProps, type StatusTone } from './StatusDot';
export { Tile, type TileProps, type TileTone } from './Tile';
