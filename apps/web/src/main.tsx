import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { applyFlagAttributes } from './lib/flags';
import { i18nReady } from './lib/i18n';
import { installStaleBuildRecovery } from './lib/stale-build';
import { injectStatusTokens } from './lib/status-tokens';
import './index.css';

applyFlagAttributes(document.documentElement);
injectStatusTokens();
installStaleBuildRecovery();

// Hindi / Tamil users wait for their language bundle (loaded on demand) so the first paint is already translated;
// English needs nothing. A failed bundle load still renders (English fallback).
void i18nReady.finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
