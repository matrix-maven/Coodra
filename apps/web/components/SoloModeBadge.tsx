import { StatusChip } from './StatusChip';

/**
 * Tiny header badge that's the right-edge affordance in solo mode. In
 * team mode the Clerk OrganizationSwitcher + UserButton replace it.
 */

export function SoloModeBadge() {
  return <StatusChip status="neutral">Solo mode</StatusChip>;
}
