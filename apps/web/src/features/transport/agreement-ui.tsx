import type { TransportAgreementAction, TransportAgreementDto, TransportAgreementStatus } from '@veetracer/shared';
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleOffIcon,
  CirclePauseIcon,
  CirclePlayIcon,
  ClockIcon,
  FilePenLineIcon,
  PencilIcon,
  RefreshCwIcon,
  SendIcon,
  XCircleIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { getReportTimeZone } from '@/features/reports/report-time';
import { ApiError, errorMessage } from '@/lib/api';
import { currentLocale, i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  ACTION_META,
  AGREEMENT_STATUS_LABEL,
  AGREEMENT_STATUS_TONE,
  agreementButtons,
  agreementErrorKind,
  CONFLICT_MESSAGE,
  counterpartyName,
  proposeBlockers,
  REASON_MAX,
  reasonError,
  validToLastDay,
} from './agreement-format';
import { AgreementFormDialog } from './AgreementFormDialog';
import { useAgreementMutation, useInvalidateAgreements } from './use-agreements';

const dayFmt = (iso: string) => new Date(iso).toLocaleDateString(currentLocale(), { day: '2-digit', month: 'short', year: 'numeric', timeZone: getReportTimeZone() });

/** "01 Dec 2026 – 31 Dec 2027" / "From 01 Dec 2026" (last day inclusive, in the company zone). */
export function validityText(a: Pick<TransportAgreementDto, 'validFrom' | 'validTo'>): string {
  const from = dayFmt(a.validFrom);
  if (!a.validTo) return i18n.t('From {{date}}', { date: from });
  const last = validToLastDay(a.validTo, getReportTimeZone());
  // Noon UTC of the last day lands on that calendar day in every zone within ±12 h.
  return `${from} – ${last ? dayFmt(`${last}T12:00:00Z`) : '—'}`;
}

/** Shape cue per status so status is never told by colour alone. */
export const STATUS_ICON: Record<TransportAgreementStatus, LucideIcon> = {
  DRAFT: FilePenLineIcon,
  PROPOSED: ClockIcon,
  ACTIVE: CheckCircle2Icon,
  SUSPENDED: CirclePauseIcon,
  ENDED: CircleOffIcon,
};

export function AgreementStatusBadge({ status, className }: { status: TransportAgreementStatus; className?: string }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={AGREEMENT_STATUS_TONE[status]} className={className}>
      <Icon aria-hidden />
      {t(AGREEMENT_STATUS_LABEL[status])}
    </Badge>
  );
}

const ACTION_ICON: Record<TransportAgreementAction, LucideIcon> = {
  edit: PencilIcon,
  propose: SendIcon,
  approve: CheckCircle2Icon,
  suspend: CirclePauseIcon,
  resume: CirclePlayIcon,
  end: XCircleIcon,
};

export const actionIcon = (a: TransportAgreementAction) => ACTION_ICON[a] ?? CircleDashedIcon;

/** Server error, with a clear "changed by someone else" message and a reload button for VERSION_CONFLICT. */
export function AgreementError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  if (agreementErrorKind(code) === 'conflict') {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning-fg sm:flex-row sm:items-center">
        <span className="flex-1">{t(CONFLICT_MESSAGE)}</span>
        {onReload && (
          <Button size="sm" variant="outline" onClick={onReload} className="self-start sm:self-auto">
            <RefreshCwIcon /> {t('Reload')}
          </Button>
        )}
      </div>
    );
  }
  return <FormError message={errorMessage(error)} />;
}

/** Confirm dialog of one command (propose / approve / suspend / resume / end), with a reason when required. */
function ActionDialog({ pending, onClose }: { pending: { action: Exclude<TransportAgreementAction, 'edit'>; agreement: TransportAgreementDto } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const mutation = useAgreementMutation();
  const invalidate = useInvalidateAgreements();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  // Keep the last content while the dialog animates out.
  const [last, setLast] = useState(pending);
  if (pending && pending !== last) setLast(pending);
  const shown = pending ?? last;

  useEffect(() => {
    if (!pending) return;
    setReason('');
    setTried(false);
    mutation.reset();
    // Reset when another agreement / action opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.agreement.id, pending?.action]);

  if (!shown) return null;
  const baseMeta = ACTION_META[shown.action];
  // F7: VeeTrax support also gives a reason when it proposes (server: required for the Super Admin).
  const meta = { ...baseMeta, needsReason: baseMeta.needsReason || (!!me?.user.isSuperAdmin && shown.action === 'propose') };
  const blockers = shown.action === 'propose' ? proposeBlockers(shown.agreement) : [];
  const reasonErr = meta.needsReason ? reasonError(reason) : null;

  const submit = () => {
    setTried(true);
    if (!pending || reasonErr || blockers.length) return;
    mutation.mutate(
      { kind: pending.action, id: pending.agreement.id, version: pending.agreement.version, reason: meta.needsReason ? reason.trim() : undefined },
      {
        onSuccess: (row) => {
          toast.success(
            pending.action === 'approve' && row.status === 'PROPOSED'
              ? t('Approved for your company. Waiting for the other company.')
              : t('Agreement is now {{status}}', { status: t(AGREEMENT_STATUS_LABEL[row.status]).toLowerCase() }),
          );
          onClose();
        },
      },
    );
  };
  const reload = () => {
    invalidate();
    onClose();
  };

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && !mutation.isPending && onClose()}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>{t(meta.title)}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{counterpartyName(shown.agreement)}</span>
            {' · '}
            {t(meta.body)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {blockers.length > 0 && <FormError message={blockers.map((b) => t(b)).join('\n')} />}
          {meta.needsReason && (
            <Field label={t('Reason')} htmlFor="agreement-reason" required error={tried && reasonErr ? t(reasonErr) : undefined} hint={t('{{n}} / {{max}} characters', { n: reason.trim().length, max: REASON_MAX })}>
              <Textarea id="agreement-reason" value={reason} maxLength={REASON_MAX + 50} rows={3} autoFocus onChange={(e) => setReason(e.target.value)} aria-invalid={(tried && !!reasonErr) || undefined} />
            </Field>
          )}
          <AgreementError error={mutation.error} onReload={reload} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            {t('Cancel')}
          </Button>
          <Button variant={meta.variant === 'destructive' ? 'destructive' : 'default'} onClick={submit} disabled={mutation.isPending || blockers.length > 0}>
            {mutation.isPending && <Spinner />}
            {t(meta.confirm)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** `request(action, agreement)` opens the edit dialog or the matching confirm dialog; render `dialogs` once. */
export function useAgreementActions(): { request: (action: TransportAgreementAction, a: TransportAgreementDto) => void; dialogs: ReactNode } {
  const [edit, setEdit] = useState<TransportAgreementDto | null>(null);
  const [command, setCommand] = useState<{ action: Exclude<TransportAgreementAction, 'edit'>; agreement: TransportAgreementDto } | null>(null);
  const request = (action: TransportAgreementAction, agreement: TransportAgreementDto) => {
    if (action === 'edit') setEdit(agreement);
    else setCommand({ action, agreement });
  };
  const dialogs = (
    <>
      {edit && <AgreementFormDialog record={edit} open onOpenChange={(o) => !o && setEdit(null)} />}
      <ActionDialog pending={command} onClose={() => setCommand(null)} />
    </>
  );
  return { request, dialogs };
}

/** The server's `allowedActions` as buttons (wraps on phones; full-width stack below 640 px). */
export function AgreementActionButtons({ agreement, onAction, className }: { agreement: TransportAgreementDto; onAction: (a: TransportAgreementAction, row: TransportAgreementDto) => void; className?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const actions = agreementButtons(agreement.allowedActions, can('etms_partners', 'edit'));
  if (!actions.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {actions.map((a) => {
        const Icon = actionIcon(a);
        const meta = ACTION_META[a];
        return (
          <Button key={a} variant={meta.variant} onClick={() => onAction(a, agreement)}>
            <Icon /> {t(meta.label)}
          </Button>
        );
      })}
    </div>
  );
}
