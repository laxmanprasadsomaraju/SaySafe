import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], env: { DATABASE_FILE: ':memory:', GROQ_API_KEY: '', NODE_ENV: 'test', DEMO_SEED: 'off' }, testTimeout: 15000 } });
