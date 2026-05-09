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
export { CodeBlock, type CodeBlockProps } from './CodeBlock';
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
export { type EventDot, EventRow, type EventRowProps, type EventVerdict } from './EventRow';
export { FormRow, type FormRowProps } from './FormRow';
export { IconField, type IconFieldProps, type IconFieldTone } from './IconField';
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
  ActivityIcon,
  AlertTriangleIcon,
  ArrowLeftIcon,
  BookIcon,
  BoxIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  CommandIcon,
  CopyIcon,
  DatabaseIcon,
  DocumentIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderIcon,
  GaugeIcon,
  GraphIcon,
  HashIcon,
  HelpCircleIcon,
  InfoIcon,
  LayersIcon,
  LayoutIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  RocketIcon,
  ScrollIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SparkleIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from './icons';
export { KsModeButton, type KsModeButtonProps } from './KsModeButton';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { PageShell, type PageShellProps } from './PageShell';
export { PolicyRow, type PolicyRowProps, type PolicyVerdictTone } from './PolicyRow';
export { Section, type SectionProps } from './Section';
export { StatPill, type StatPillProps, type StatPillTone } from './StatPill';
export { StatusDot, type StatusDotProps, type StatusTone } from './StatusDot';
export { Tile, type TileProps, type TileTone } from './Tile';
export { Topbar, type TopbarProps } from './Topbar';
