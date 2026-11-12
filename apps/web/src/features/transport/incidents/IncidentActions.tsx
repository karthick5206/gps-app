import { INCIDENT_RESOLUTIONS, SOS_LIMITS, type IncidentResolution } from '@veetracer/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { noteError, RESOLUTION_LABEL } from './sos-lane';
import { useAckIncident, useResolveIncident } from './use-incidents';

/** Acknowledge an SOS: a note is required (what was done), as on the server (doc 05 §2.10). */
export function AckIncidentDialog({ incidentId, open, onOpenChange }: { incidentId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const ack = useAckIncident();
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setNote('');
      setTried(false);
      ack.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const err = noteError(note, SOS_LIMITS.ackNoteMax);
  const submit = () => {
    setTried(true);
    if (err || !incidentId) return;
    ack.mutate(
      { id: incidentId, note: note.trim() },
      {
        onSuccess: () => {
          toast.success(t('SOS acknowledged'));
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !ack.isPending && onOpenChange(o)}>
      <DialogContent>
        <form noValidate className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={(e) => (e.preventDefault(), submit())}>
          <DialogHeader>
            <DialogTitle>{t('Acknowledge SOS')}</DialogTitle>
            <DialogDescription>{t('The passenger or driver sees that the desk acknowledged. Write what you did or are doing.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {ack.error && <FormError message={errorMessage(ack.error)} />}
            <Field label={t('Note')} htmlFor="sos-ack-note" required error={tried && err ? t(err) : undefined}>
              <Textarea id="sos-ack-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={SOS_LIMITS.ackNoteMax} rows={3} autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)} disabled={ack.isPending}>
              {t('Back')}
            </Button>
            <Button type="submit" variant="destructive" disabled={ack.isPending}>
              {ack.isPending && <Spinner />}
              {t('Acknowledge')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Resolve (close) an incident: outcome + note, both required. */
export function ResolveIncidentDialog({ incidentId, open, onOpenChange }: { incidentId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const resolve = useResolveIncident();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState<IncidentResolution | ''>('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setNote('');
      setOutcome('');
      setTried(false);
      resolve.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const err = noteError(note, SOS_LIMITS.resolveNoteMax);
  const submit = () => {
    setTried(true);
    if (err || !outcome || !incidentId) return;
    resolve.mutate(
      { id: incidentId, resolution: outcome, note: note.trim() },
      {
        onSuccess: () => {
          toast.success(t('Incident resolved'));
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !resolve.isPending && onOpenChange(o)}>
      <DialogContent>
        <form noValidate className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={(e) => (e.preventDefault(), submit())}>
          <DialogHeader>
            <DialogTitle>{t('Resolve incident')}</DialogTitle>
            <DialogDescription>{t('Close the incident with its outcome. The record is kept.')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {resolve.error && <FormError message={errorMessage(resolve.error)} />}
            <Field label={t('Outcome')} htmlFor="sos-outcome" required error={tried && !outcome ? t('Choose an outcome') : undefined}>
              <Select value={outcome || undefined} onValueChange={(v) => setOutcome(v as IncidentResolution)}>
                <SelectTrigger id="sos-outcome">
                  <SelectValue placeholder={t('Choose an outcome')} />
                </SelectTrigger>
                <SelectContent>
                  {INCIDENT_RESOLUTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(RESOLUTION_LABEL[r])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('Note')} htmlFor="sos-resolve-note" required error={tried && err ? t(err) : undefined}>
              <Textarea id="sos-resolve-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={SOS_LIMITS.resolveNoteMax} rows={3} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)} disabled={resolve.isPending}>
              {t('Back')}
            </Button>
            <Button type="submit" disabled={resolve.isPending}>
              {resolve.isPending && <Spinner />}
              {t('Resolve')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
