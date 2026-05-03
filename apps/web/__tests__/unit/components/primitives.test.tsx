import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RiskBadge } from '@/components/RiskBadge';
import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';

afterEach(cleanup);

describe('StatusChip', () => {
  it.each([
    'success',
    'warning',
    'error',
    'info',
    'neutral',
  ] as const)('renders with status="%s" and exposes data-status', (status) => {
    const { getByTestId } = render(<StatusChip status={status}>label</StatusChip>);
    const chip = getByTestId('status-chip');
    expect(chip.dataset.status).toBe(status);
    expect(chip.textContent).toBe('label');
  });

  it('uses the correct status color border-left', () => {
    const { getByTestId } = render(<StatusChip status="success">ok</StatusChip>);
    const chip = getByTestId('status-chip');
    expect(chip.className).toContain('border-l-(--color-status-success)');
  });
});

describe('RiskBadge', () => {
  it.each(['low', 'medium', 'high'] as const)('renders with level="%s"', (level) => {
    const { getByTestId } = render(<RiskBadge level={level}>r</RiskBadge>);
    const badge = getByTestId('risk-badge');
    expect(badge.dataset.level).toBe(level);
  });
});

describe('ToolBadge', () => {
  it('renders the tool name and exposes data-tool', () => {
    const { getByTestId } = render(<ToolBadge name="Bash" />);
    const badge = getByTestId('tool-badge');
    expect(badge.dataset.tool).toBe('Bash');
    expect(badge.textContent).toBe('Bash');
  });

  it('uses --font-mono class for tool names (engineering rigor — IDs/paths/code/tools)', () => {
    const { getByTestId } = render(<ToolBadge name="Write" />);
    const badge = getByTestId('tool-badge');
    expect(badge.className).toContain('font-mono');
  });
});
