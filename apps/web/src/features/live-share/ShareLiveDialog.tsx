import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIVE_SHARE_DEFAULT_HOURS, LIVE_SHARE_MAX_HOURS, type LiveShareCreatedDto, type LiveShareDto } from '@veetracer/shared';
import { CopyIcon, MessageCircleIcon, Share2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const QUICK_HOURS = [1, 2, 4, 8, 24, 72];

/** Live map → vehicle → Share: a link anyone can open in a browser, valid for the hours entered. */
export function ShareLiveButton({ objectId, name }: { objectId: string; name: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Share2Icon /> {t('Share live')}
      </Button>
      {open && <ShareLiveDialog objectId={objectId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareLiveDialog({ objectId, name, onClose }: { objectId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [hours, setHours] = useState(String(LIVE_SHARE_DEFAULT_HOURS));
  const [note, setNote] = useState('');
  const [created, setCreated] = useState<LiveShareCreatedDto | null>(null);
  const shares = useQuery({ queryKey: ['live-shares', objectId], queryFn: ({ signal }) => api.get<LiveShareDto[]>('/live-shares', { objectId }, signal) });
  const h = Number(hours);
  const valid = Number.isInteger(h) && h >= 1 && h <= LIVE_SHARE_MAX_HOURS;
  const create = useMutation({
    mutationFn: () => api.post<LiveShareCreatedDto>('/live-shares', { objectId, hours: h, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: (s) => {
      setCreated(s);
      void qc.invalidateQueries({ queryKey: ['live-shares', objectId] });
      void navigator.clipboard?.writeText(s.url).then(() => toast.success(t('Link copied')), () => undefined);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<LiveShareDto>(`/live-shares/${id}/revoke`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['live-shares', objectId] });
      toast.success(t('Sharing stopped'));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const message = created ? t('Live location of {{name}} (valid for {{hours}} h): {{url}}', { name, hours: created.hours, url: created.url }) : '';
  const active = (shares.data ?? []).filter((s) => s.active);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Share live location: {{name}}', { name })}</DialogTitle>
          <DialogDescription>{t('Anyone with the link can watch the live position, speed and status in a browser, without the app, until it expires.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {created ? (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">{t('Valid until {{time}}', { time: formatDateTime(created.expiresAt) })}</p>
              <Input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label={t('Share link')} className="font-mono text-xs" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void navigator.clipboard?.writeText(created.url).then(() => toast.success(t('Link copied')))}>
                  <CopyIcon /> {t('Copy link')}
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
                    <MessageCircleIcon /> {t('WhatsApp')}
                  </a>
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Field label={t('Valid for (hours)')} htmlFor="share-hours" hint={t('1 to {{max}} hours', { max: LIVE_SHARE_MAX_HOURS })}>
                <Input id="share-hours" type="number" inputMode="numeric" min={1} max={LIVE_SHARE_MAX_HOURS} value={hours} onChange={(e) => setHours(e.target.value)} className="w-32" />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_HOURS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setHours(String(q))}
                    className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', String(q) === hours ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  >
                    {q < 24 ? t('{{n}} h', { n: q }) : t('{{n}} days', { n: q / 24 })}
                  </button>
                ))}
              </div>
              <Field label={t('Note (optional)')} htmlFor="share-note">
                <Input id="share-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={t('e.g. Delivery to Anna Nagar')} />
              </Field>
            </>
          )}
          {active.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t('Active links')}</p>
              {active.map((s) => (
                <div key={s.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
                  <Badge variant="secondary">{t('{{n}} h', { n: s.hours })}</Badge>
                  <span className="min-w-0 flex-1 truncate">
                    {t('until {{time}}', { time: formatDateTime(s.expiresAt) })}
                    {s.note && ` · ${s.note}`} · {t('{{n}} views', { n: s.viewCount })}
                  </span>
                  <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                    {t('Stop')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {created ? t('Done') : t('Cancel')}
          </Button>
          {!created && (
            <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
              {create.isPending && <Spinner />} {t('Create link')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
