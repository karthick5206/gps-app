import { ETMS_ROLE_TEMPLATES, MENUS, type Action, type MenuKey } from '@veetracer/shared';
import { Building2Icon, CheckIcon, CopyIcon, ExternalLinkIcon, InfoIcon, ShieldCheckIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { ConsentNoticesPanel } from './ConsentNoticeSettings';

const ACTION_LABEL: Record<Action, string> = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', export: 'Export', command: 'Command' };
const menuLabel = (key: string) => MENUS.find((m) => m.key === key)?.label ?? key;
/** Templates for people who use only the mobile app. */
const MOBILE_ONLY = new Set(['Transport passenger', 'Transport driver']);

function CopyId({ id }: { id: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('Copy failed. Select the ID and copy it by hand.'));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <code className="min-w-0 rounded-md border bg-muted px-2.5 py-1.5 font-mono text-xs break-all select-all sm:text-sm">{id}</code>
      <Button variant="outline" size="sm" onClick={copy} className="self-start sm:self-auto">
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? t('Copied') : t('Copy')}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? t('Copied') : ''}
      </span>
    </div>
  );
}

/**
 * Transport settings, E1a: module status, the company ID partners need for an agreement, the role templates the module
 * created and how the module is switched. Operational settings (sites, cut-offs, buffers) arrive with bookings (E3).
 */
export function TransportSettingsPage() {
  const { t } = useTranslation();
  const { me, can, companyId } = useAuth();
  if (!me) return null;
  const platformHome = me.user.isSuperAdmin && !companyId;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t('Transport settings')} description={t('How employee transport is set up for your company.')} />

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel title={t('Module')} id="etms-module" action={<Badge variant="success">{t('On')}</Badge>}>
          <div className="space-y-3 text-sm">
            <p>{t('Employee transport is switched on for {{company}}.', { company: me.company.name })}</p>
            <p className="text-muted-foreground">{t('This version covers transport agreements, the transport roles, passengers (profiles, home pickup points, consent, app logins, import), vehicle seats and driver app logins. Bookings and trips follow in the next updates.')}</p>
            {can('sa_companies') ? (
              <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center">
                <Building2Icon className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
                <p className="flex-1 text-xs text-muted-foreground">{t('Super Admin: switch the module per company in Platform → Companies → Edit company → Employee transport.')}</p>
                <Button variant="outline" size="sm" asChild className="self-start sm:self-auto">
                  <Link to="/platform/companies">
                    <ExternalLinkIcon /> {t('Companies')}
                  </Link>
                </Button>
              </div>
            ) : (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t('The module is switched on or off by VeeTrax. Contact support to change it.')}
              </p>
            )}
          </div>
        </Panel>

        <Panel title={t('Your company ID')} subtitle={t('Give it to a transport partner so they can start an agreement with you')} id="etms-company-id">
          {platformHome ? (
            <p className="text-sm text-muted-foreground">{t('The platform company is never a party to an agreement. Act as a company to see its ID.')}</p>
          ) : (
            <CopyId id={me.company.id} />
          )}
        </Panel>
      </div>

      {!platformHome && <ConsentNoticesPanel />}

      <Panel
        title={t('Transport roles')}
        subtitle={t('Created once in your company when the module was switched on. They are ordinary roles: change or copy them under Administration → Roles.')}
        id="etms-roles"
        action={
          can('roles') && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/admin/roles">
                <ShieldCheckIcon /> {t('Roles')}
              </Link>
            </Button>
          )
        }
      >
        <ul className="grid gap-3 md:grid-cols-2">
          {ETMS_ROLE_TEMPLATES.map((r) => (
            <li key={r.name} className="min-w-0 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{t(r.name)}</p>
                <Badge variant="muted">{r.dataScope === 'COMPANY' ? t('Whole company') : t('Assigned only')}</Badge>
                {MOBILE_ONLY.has(r.name) && (
                  <Badge variant="info">
                    <SmartphoneIcon aria-hidden /> {t('Mobile app')}
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(r.description)}</p>
              <details className="group mt-2 text-xs">
                <summary className="cursor-pointer rounded font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{t('Show permissions')}</summary>
                <ul className="mt-2 grid gap-1">
                  {Object.entries(r.permissions).map(([menu, actions]) => (
                    <li key={menu} className="flex flex-wrap gap-x-2">
                      <span className="font-medium">{t(menuLabel(menu as MenuKey))}</span>
                      <span className="text-muted-foreground">{(actions ?? []).map((a) => t(ACTION_LABEL[a])).join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
