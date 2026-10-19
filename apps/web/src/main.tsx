import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './lib/i18n';
import { installStaleBuildRecovery } from './lib/stale-build';
import { injectStatusTokens } from './lib/status-tokens';
import './index.css';

injectStatusTokens();
installStaleBuildRecovery();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
