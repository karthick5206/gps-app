import type { TransportAgreementDto, TransportAgreementStatus } from '@veetracer/shared';
import { ALL_COMPANIES, TRANSPORT_AGREEMENT_STATUSES } from '@veetracer/shared';
import { BuildingIcon, ExternalLinkIcon, HandshakeIcon, ShieldAlertIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { DateCell } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { i18n } from '@/lib/i18n';
import { AGREEMENT_STATUS_LABEL, counterpartyName, GRANT_META, orderedGrants, SIDE_LABEL } from './agreement-format';
import { AgreementStatusBadge, validityText } from './agreement-ui';
import { ACCESS_LOG_PATH } from './AccessLogPage';
import { AgreementFormDialog } from './AgreementFormDialog';
import { AGREEMENTS_ENDPOINT, agreementPath } from './use-agreements';

function AgreementForm({ record, open, onOpenChange }: MasterFormProps<TransportAgreementDto>) {
  return <AgreementFormDialog record={record} open={open} onOpenChange={onOpenChange} />;
}

const STATUS_FILTER: MasterFilter = {
  key: 'agreementStatus',
  label: 'Agreement status',
  options: TRANSPORT_AGREEMENT_STATUSES.map((s: TransportAgreementStatus) => ({ value: s, label: AGREEMENT_STATUS_LABEL[s] })),
};
const SIDE_FILTER: MasterFilter = {
  key: 'side',
  label: 'Our role',
  options: [
    { value: 'CUSTOMER', label: 'We are the customer' },
    { value: 'PROVIDER', label: 'We are the provider' },
  ],
};

/**
 * Transport partners & agreements (menu `etms_partners`): MasterPage list with status / side filters and CSV; the row
 * opens the detail page, which carries the lifecycle actions. Delete does not exist (agreements are ended, not deleted).
 */
export function PartnersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me, companyId, can } = useAuth();
  // The Super Admin in its own (platform) company sees every agreement and is a party to none: "our role" means nothing.
  const platformView = !!me?.user.isSuperAdmin && (!companyId || companyId === ALL_COMPANIES);

  const columns = useMemo<MasterColumn<TransportAgreementDto>[]>(
    () => [
      {
        id: 'partner',
        header: 'Partner',
        hideable: false,
        cell: (r) => (
          <Link to={agreementPath(r.id)} className="font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none">
            {counterpartyName(r)}
          </Link>
        ),
      },
      { id: 'side', header: 'Our role', cell: (r) => (r.side ? i18n.t(SIDE_LABEL[r.side]) : <span className="text-muted-foreground">{i18n.t('Platform')}</span>) },
      {
        id: 'status',
        header: 'Status',
        sortable: true,
        cell: (r) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            <AgreementStatusBadge status={r.status} />
            {r.status === 'ACTIVE' && !r.inForce && <Badge variant="muted">{i18n.t('Outside validity')}</Badge>}
            {r.allowedActions.includes('approve') && <Badge variant="warning">{i18n.t('Needs your approval')}</Badge>}
          </span>
        ),
      },
      { id: 'validFrom', header: 'Validity', sortable: true, cell: (r) => <span className="whitespace-nowrap">{validityText(r)}</span> },
      {
        id: 'grants',
        header: 'Grants',
        cell: (r) =>
          r.grants.length ? (
            <span title={orderedGrants(r.grants).map((g) => i18n.t(GRANT_META[g].label)).join(', ')}>{i18n.t('{{n}} grant(s)', { n: r.grants.length })}</span>
          ) : (
            <span className="text-muted-foreground">{i18n.t('None yet')}</span>
          ),
      },
      { id: 'sites', header: 'Sites', cell: (r) => (r.siteIds.length ? i18n.t('{{n}} site(s)', { n: r.siteIds.length }) : i18n.t('All sites')) },
      { id: 'provider', header: 'Provider', defaultHidden: true, cell: (r) => r.providerCompanyName },
      { id: 'customer', header: 'Customer', defaultHidden: true, cell: (r) => r.customerCompanyName },
      { id: 'updatedAt', header: 'Updated', sortable: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
      { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
    ],
    [],
  );

  const rowActions = useCallback(
    (r: TransportAgreementDto) => (
      <DropdownMenuItem onSelect={() => navigate(agreementPath(r.id))}>
        <ExternalLinkIcon /> {t('Open agreement')}
      </DropdownMenuItem>
    ),
    [navigate, t],
  );

  return (
    <MasterPage<TransportAgreementDto>
      menu="etms_partners"
      title="Transport partners & agreements"
      description="Who runs transport for whom, what they may do, and for how long. Both companies approve every agreement."
      endpoint={AGREEMENTS_ENDPOINT}
      columns={columns}
      rowLabel={counterpartyName}
      filters={platformView ? [STATUS_FILTER] : [STATUS_FILTER, SIDE_FILTER]}
      statusFilter={false}
      bulkActions={false}
      history={false}
      defaultSort={{ id: 'updatedAt', desc: true }}
      Form={AgreementForm}
      canEditRow={(r) => r.allowedActions.includes('edit')}
      canDeleteRow={() => false}
      rowActions={rowActions}
      emptyIcon={HandshakeIcon}
      headerActions={
        <>
          {/* P1: VeeTrax support creates customer companies (Platform → Companies, add-on Employee transport). */}
          {platformView && can('sa_companies', 'create') && (
            <Button variant="outline" asChild>
              <Link to="/platform/companies">
                <BuildingIcon /> <span className="hidden sm:inline">{t('New customer company')}</span>
              </Link>
            </Button>
          )}
          {!platformView && (
            <Button variant="outline" asChild>
              <Link to={ACCESS_LOG_PATH} aria-label={t('Sensitive-access log')}>
                <ShieldAlertIcon /> <span className="hidden sm:inline">{t('Sensitive-access log')}</span>
              </Link>
            </Button>
          )}
        </>
      }
    />
  );
}
