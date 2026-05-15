/**
 * `src/ui/ink/index.ts` — barrel for the Coodra Ink component
 * library. The interactive TUI (`src/tui/`) imports its building blocks
 * from here; one-shot command handlers must NOT import this module —
 * they use the string formatters in `src/ui/format.ts` so their bundle
 * never pulls in React.
 */

export { AxisNode, type AxisNodeProps } from './AxisNode.js';
export { Banner, type BannerProps } from './Banner.js';
export { BrandMark, type BrandMarkProps, type BrandVariant } from './BrandMark.js';
export { CommandRow, type CommandRowProps } from './CommandRow.js';
export { Divider, type DividerProps } from './Divider.js';
export { Footer, type FooterHint, type FooterProps } from './Footer.js';
export { type TerminalSize, useTerminalSize } from './hooks.js';
export { KeyValueRow, type KeyValueRowProps } from './KeyValueRow.js';
export { Prompt, type PromptProps } from './Prompt.js';
export { Rule, type RuleProps } from './Rule.js';
export { SectionHead, type SectionHeadProps } from './SectionHead.js';
export { Spinner, type SpinnerProps } from './Spinner.js';
export { StatusDot, type StatusDotProps } from './StatusDot.js';
export { SummaryBar, type SummaryBarProps, type SummarySegment } from './SummaryBar.js';
export { TimelineRow, type TimelineRowProps } from './TimelineRow.js';
export { TopBar, type TopBarProps, type TopBarTab } from './TopBar.js';
