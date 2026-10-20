/** Jest setup: defaults for modules that read required env at import time (no .env in CI / fresh clones). */
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
