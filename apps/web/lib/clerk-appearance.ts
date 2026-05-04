/**
 * `apps/web/lib/clerk-appearance.ts` — Clerk appearance prop for the
 * full UI redesign.
 *
 * Drops the brutalist zero-radius + uppercase-tracking overrides in
 * favor of Clerk's defaults aligned with our refined modern look:
 * 8px border-radius, sentence-case button labels, brand blue.
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#2563eb',
    colorBackground: '#ffffff',
    colorText: '#18181b',
    colorTextSecondary: '#52525b',
    colorInputBackground: '#ffffff',
    colorInputText: '#18181b',
    colorDanger: '#ef4444',
    colorSuccess: '#10b981',
    fontFamily: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontFamilyButtons: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
    borderRadius: '8px',
    spacingUnit: '8px',
  },
  elements: {
    formButtonPrimary: 'font-medium',
    socialButtonsBlockButton: 'font-medium',
    formFieldLabel: 'text-sm font-medium',
    headerTitle: 'font-display font-semibold tracking-tight',
    rootBox: 'font-sans',
    card: 'border border-border-default shadow-sm',
  },
};
