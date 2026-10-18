import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './lib/i18n';
import { injectStatusTokens } from './lib/status-tokens';
import './index.css';

injectStatusTokens();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
