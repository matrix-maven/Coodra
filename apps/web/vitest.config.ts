import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['__tests__/unit/**/*.test.ts', '__tests__/unit/**/*.test.tsx'],
    globals: false,
    typecheck: { enabled: false },
  },
  resolve: {
    alias: {
      '@/': new URL('./', import.meta.url).pathname,
    },
  },
});
