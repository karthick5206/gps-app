import { BookOpenIcon, KeyRoundIcon, WebhookIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiKeysTab } from './ApiKeysTab';
import { DocsTab } from './DocsTab';
import { WebhooksTab } from './WebhooksTab';

const TAB_KEY = 'vt:developer-tab';

function initialTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? 'keys';
  } catch {
    return 'keys';
  }
}

/** Administration → Developer API: API keys, webhooks and the API reference. */
export function DeveloperApiPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState(initialTab);
  const change = (v: string) => {
    setTab(v);
    try {
      localStorage.setItem(TAB_KEY, v);
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader title={t('Developer API')} description={t('Connect your ERP, dispatch or BI system to VeeTrax with API keys and webhooks.')} />
      <Tabs value={tab} onValueChange={change}>
        <TabsList>
          <TabsTrigger value="keys">
            <KeyRoundIcon className="size-4" />
            {t('API keys')}
          </TabsTrigger>
          <TabsTrigger value="webhooks">
            <WebhookIcon className="size-4" />
            {t('Webhooks')}
          </TabsTrigger>
          <TabsTrigger value="docs">
            <BookOpenIcon className="size-4" />
            {t('Docs')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="keys" className="mt-4">
          <ApiKeysTab />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <WebhooksTab />
        </TabsContent>
        <TabsContent value="docs" className="mt-4">
          <DocsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
