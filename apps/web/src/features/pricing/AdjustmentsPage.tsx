import { ADJUSTMENT_STATUSES, REQUESTABLE_ADJUSTMENT_KINDS, type BillingAdjustmentDto, type CreateBillingAdjustmentRequest, type PricingPage } from '@veetracer/shared';
import { CheckIcon, ListChecksIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { canDecide } from './access';
import { amountError } from './money';
import { P, useContractOptions, usePricingMutation, usePricingQuery } from './pricing-api';
import { Empty, enumLabel, FilterBar, Labeled, Money, Pager, PricingShell, QueryView, ReasonDialog, ScrollTable, Sel, SimpleDialog, StatusPill, Td, Th } from './ui';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pricing → Billing adjustments (menu pricing_adjustments): requests and the maker-checker approval queue. */
export function AdjustmentsPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [params, setParams] = useSearchParams();
  const { contracts } = useContractOptions();
  const status = params.get('status') ?? (can('pricing_adjustments', 'approve') ? 'PENDING_APPROVAL' : '');
  const contractId = params.get('contract') ?? '';
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateBillingAdjustmentRequest>({ contractId: '', kind: 'CREDIT', amount: '', reason: '', transportTripId: '' });
  const [touched, setTouched] = useState(false);
  const [deciding, setDeciding] = useState<{ adj: BillingAdjustmentDto; approve: boolean } | null>(null);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
    setPage(1);
  };
  const list = usePricingQuery<PricingPage<BillingAdjustmentDto>>(['adjustments'], `${P}/adjustments`, { status: status || undefined, contractId: contractId || undefined, page, pageSize: PAGE_SIZE });
  const contractName = (id: string) => contracts.find((c) => c.id === id)?.name ?? '—';
  const formContract = contracts.find((c) => c.id === (form.contractId || contracts[0]?.id));
  const amtErr = formContract ? amountError(form.amount, formContract.currency) : 'Choose a contract';
  const tripErr = form.transportTripId && !UUID.test(form.transportTripId.trim()) ? 'Enter the trip id (from Trip charges)' : null;
  const create = usePricingMutation(() => api.post(`${P}/adjustments`, { ...form, contractId: formContract!.id, amount: form.amount.trim(), reason: form.reason.trim(), transportTripId: form.transportTripId?.trim() || null } satisfies CreateBillingAdjustmentRequest), { success: 'Adjustment requested', toastError: false, onSuccess: () => setCreating(false) });
  const decide = usePricingMutation((note: string) => api.post(`${P}/adjustments/${deciding!.adj.id}/${deciding!.approve ? 'approve' : 'reject'}`, { note: note || null }), { success: 'Decision saved', toastError: false, onSuccess: () => setDeciding(null) });
  return (
    <PricingShell
      title={t('Billing adjustments')}
      description={t('Credits, debits and waivers on a contract, and trip price overrides waiting for approval. A second user approves; approved adjustments go on the next invoice.')}
      actions={
        can('pricing_adjustments', 'create') && (
          <Button size="sm" onClick={() => (setForm({ contractId: contractId || contracts[0]?.id || '', kind: 'CREDIT', amount: '', reason: '', transportTripId: '' }), setTouched(false), setCreating(true))} disabled={!contracts.length}>
            <PlusIcon /> {t('Request adjustment')}
          </Button>
        )
      }
    >
      <FilterBar>
        <Labeled label="Status">{(id) => <Sel id={id} value={status} allLabel="All statuses" onChange={(v) => set('status', v)} options={ADJUSTMENT_STATUSES.map((s) => ({ value: s, label: t(enumLabel(s)) }))} />}</Labeled>
        <Labeled label="Contract">{(id) => <Sel id={id} value={contractId} allLabel="All contracts" onChange={(v) => set('contract', v)} options={contracts.map((c) => ({ value: c.id, label: c.name }))} />}</Labeled>
      </FilterBar>
      <QueryView query={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty icon={ListChecksIcon} title={status === 'PENDING_APPROVAL' ? 'Nothing waiting for approval' : 'No adjustments'} />
          ) : (
            <>
              <ScrollTable label={t('Billing adjustments')} minWidth={900}>
                <thead>
                  <tr>
                    <Th>{t('Requested')}</Th>
                    <Th>{t('Contract')}</Th>
                    <Th>{t('Kind')}</Th>
                    <Th>{t('Reason')}</Th>
                    <Th>{t('Status')}</Th>
                    <Th right>{t('Amount')}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((a) => {
                    const dec = canDecide({ hasApprove: can('pricing_adjustments', 'approve'), submittedById: a.requestedById, meId: me?.user.id });
                    return (
                      <tr key={a.id}>
                        <Td className="whitespace-nowrap">{formatDateTime(a.requestedAt)}</Td>
                        <Td>
                          {contractName(a.contractId)}
                          {a.transportTripId && (
                            <Link to={`/pricing/trip-charges/${a.transportTripId}`} className="block font-mono text-xs text-primary hover:underline">
                              {t('Trip')} {a.transportTripId.slice(0, 8)}
                            </Link>
                          )}
                        </Td>
                        <Td>{t(enumLabel(a.kind))}</Td>
                        <Td className="max-w-64 text-xs">
                          {a.reason}
                          {a.decisionNote && <span className="block text-muted-foreground">{t('Decision')}: {a.decisionNote}</span>}
                        </Td>
                        <Td>
                          <StatusPill status={a.status} />
                        </Td>
                        <Td right className="font-medium">
                          <Money minor={a.amountMinor} currency={a.currency} />
                        </Td>
                        <Td right>
                          {a.status === 'PENDING_APPROVAL' && can('pricing_adjustments', 'approve') && (
                            dec.ownSubmission ? (
                              <span className="text-xs text-muted-foreground">{t('You can’t approve your own request.')}</span>
                            ) : (
                              <span className="flex justify-end gap-1">
                                <Button size="sm" variant="ghost" onClick={() => setDeciding({ adj: a, approve: true })}>
                                  <CheckIcon /> {t('Approve')}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setDeciding({ adj: a, approve: false })}>
                                  <XIcon /> {t('Reject')}
                                </Button>
                              </span>
                            )
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </ScrollTable>
              <Pager page={page} pageSize={PAGE_SIZE} total={d.total} onPage={setPage} />
            </>
          )
        }
      </QueryView>
      <SimpleDialog
        open={creating}
        onOpenChange={setCreating}
        title="Request adjustment"
        description="Another user with approval rights decides. Amounts are before tax, in the contract currency."
        pending={create.isPending}
        error={create.error}
        submitLabel="Request"
        onSubmit={() => {
          setTouched(true);
          if (!amtErr && !tripErr && form.reason.trim()) create.mutate(undefined);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Contract" className="sm:col-span-2">{(id) => <Sel id={id} value={formContract?.id ?? ''} onChange={(v) => setForm({ ...form, contractId: v })} options={contracts.map((c) => ({ value: c.id, label: `${c.name} · ${c.currency}` }))} />}</Labeled>
          <Labeled label="Kind">{(id) => <Sel id={id} value={form.kind} onChange={(v) => setForm({ ...form, kind: v as CreateBillingAdjustmentRequest['kind'] })} options={REQUESTABLE_ADJUSTMENT_KINDS.map((k) => ({ value: k, label: t(k === 'DEBIT' ? 'Debit (customer pays more)' : k === 'CREDIT' ? 'Credit (customer pays less)' : 'Waiver') }))} />}</Labeled>
          <Labeled label={`${t('Amount')} (${formContract?.currency ?? ''})`} error={touched ? amtErr : null}>
            {(id) => <Input id={id} inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />}
          </Labeled>
          <Labeled label="Trip id (optional)" className="sm:col-span-2" error={tripErr}>
            {(id) => <Input id={id} value={form.transportTripId ?? ''} onChange={(e) => setForm({ ...form, transportTripId: e.target.value })} />}
          </Labeled>
          <Labeled label="Reason" className="sm:col-span-2" error={touched && !form.reason.trim() ? 'A reason is required.' : null}>
            {(id) => <Input id={id} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}
          </Labeled>
        </div>
      </SimpleDialog>
      <ReasonDialog
        open={!!deciding}
        onOpenChange={(o) => !o && setDeciding(null)}
        title={deciding?.approve ? 'Approve adjustment' : 'Reject adjustment'}
        reasonLabel={deciding?.approve ? 'Note' : 'Reason'}
        reasonRequired={!deciding?.approve}
        destructive={!deciding?.approve}
        pending={decide.isPending}
        error={decide.error}
        onSubmit={(r) => decide.mutate(r)}
        confirmLabel={deciding?.approve ? 'Approve' : 'Reject'}
      />
    </PricingShell>
  );
}
