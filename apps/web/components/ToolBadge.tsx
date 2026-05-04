/**
 * Tool-name badge per `docs/feature-packs/04-web-app/wireframes/03-component-inventory.md`.
 * Used wherever a tool name (Write, Edit, Bash, MultiEdit, etc.) appears in a list.
 */

export interface ToolBadgeProps {
  readonly name: string;
}

export function ToolBadge({ name }: ToolBadgeProps) {
  return (
    <span
      data-testid="tool-badge"
      data-tool={name}
      className="inline-flex h-5 items-center border border-border-subtle bg-bg-elevated px-2 font-mono text-[11px] font-medium text-text-primary"
    >
      {name}
    </span>
  );
}
