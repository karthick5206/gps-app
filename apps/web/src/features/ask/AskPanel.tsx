import { useMutation } from '@tanstack/react-query';
import { SEARCH_EXAMPLES, type SearchAnswerDto, type SearchCard } from '@veetracer/shared';
import { BookOpenIcon, MapPinIcon, MicIcon, SendIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

type Recognition = { lang: string; interimResults: boolean; onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start: () => void; stop: () => void };
const SpeechRecognitionCtor: (new () => Recognition) | undefined =
  typeof window === 'undefined' ? undefined : ((window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition);
const SPEECH_LANG: Record<string, string> = { en: 'en-IN', ta: 'ta-IN', hi: 'hi-IN' };

/** Top bar: ✨ Ask button (and Ctrl + K) opening the Ask VeeTrax panel. */
export function AskButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setOpen(true)} aria-label={t('Ask VeeTrax')} title={`${t('Ask VeeTrax')} (Ctrl + K)`}>
        <SparklesIcon className="text-primary" />
        <span className="hidden md:inline">{t('Ask VeeTrax')}</span>
        <kbd className="hidden rounded border px-1 text-[10px] lg:inline">Ctrl K</kbd>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <AskPanel onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

interface Turn {
  q: string;
  a: SearchAnswerDto | null;
  error: string | null;
}

function AskPanel({ onNavigate }: { onNavigate: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (q: string) => api.post<SearchAnswerDto>('/ask', { q }),
    onSuccess: (a, q) => setTurns((ts) => ts.map((x) => (x.q === q && !x.a && !x.error ? { ...x, a } : x))),
    onError: (e, q) => setTurns((ts) => ts.map((x) => (x.q === q && !x.a && !x.error ? { ...x, error: errorMessage(e) } : x))),
  });
  const send = (q: string) => {
    const s = q.trim();
    if (!s) return;
    setTurns((ts) => [...ts.slice(-9), { q: s, a: null, error: null }]);
    setText('');
    ask.mutate(s);
  };
  useEffect(() => end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }), [turns]);
  const go = (href: string) => {
    onNavigate();
    navigate(href);
  };
  const mic = () => {
    if (!SpeechRecognitionCtor) return;
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new SpeechRecognitionCtor();
    r.lang = SPEECH_LANG[i18n.language.slice(0, 2)] ?? 'en-IN';
    r.interimResults = false;
    r.onresult = (e) => send(e.results[0][0].transcript);
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="border-b p-4">
        <SheetTitle className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" /> {t('Ask VeeTrax')}
        </SheetTitle>
        <SheetDescription>
          {t('Ask about your vehicles in plain words.')}{' '}
          <Link to="/guide#ask" onClick={onNavigate} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
            <BookOpenIcon className="size-3.5" /> {t('How to ask')}
          </Link>
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {!turns.length && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('Try')}</p>
            <Examples onPick={send} />
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className="space-y-2">
            <p className="ms-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{turn.q}</p>
            {!turn.a && !turn.error && <Spinner className="size-4" />}
            {turn.error && <p className="text-sm text-destructive">{turn.error}</p>}
            {turn.a && <Answer a={turn.a} onAsk={send} onGo={go} />}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex items-center gap-2 border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('e.g. Where is TN 09 BB 9421')} aria-label={t('Your question')} autoFocus maxLength={200} />
        {SpeechRecognitionCtor && (
          <Button type="button" variant={listening ? 'destructive' : 'outline'} size="icon" onClick={mic} aria-label={listening ? t('Stop listening') : t('Speak your question')} title={t('Speak your question')}>
            <MicIcon className={cn(listening && 'animate-pulse')} />
          </Button>
        )}
        <Button type="submit" size="icon" disabled={!text.trim() || ask.isPending} aria-label={t('Ask')}>
          <SendIcon />
        </Button>
      </form>
    </div>
  );
}

function Examples({ onPick, list = SEARCH_EXAMPLES }: { onPick: (q: string) => void; list?: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((q) => (
        <button key={q} type="button" onClick={() => onPick(q)} className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
          {q}
        </button>
      ))}
    </div>
  );
}

function Answer({ a, onAsk, onGo }: { a: SearchAnswerDto; onAsk: (q: string) => void; onGo: (href: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-2xl rounded-bl-sm border bg-card p-3 text-sm">
      <p>{a.answer}</p>
      {a.cards.map((c, i) => (
        <CardView key={i} c={c} onGo={onGo} />
      ))}
      {a.choices && (
        <div className="flex flex-wrap gap-1.5">
          {a.choices.map((c) => (
            <Button key={c.objectId} size="sm" variant="outline" onClick={() => onAsk(c.query)}>
              {c.label}
            </Button>
          ))}
        </div>
      )}
      {a.examples && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t('Try one of these')}</p>
          <Examples onPick={onAsk} list={a.examples} />
        </div>
      )}
      {a.links.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {a.links.map((l) => (
            <Button key={l.href} size="sm" variant="secondary" onClick={() => onGo(l.href)}>
              {t(l.label)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function CardView({ c, onGo }: { c: SearchCard; onGo: (href: string) => void }) {
  const { t } = useTranslation();
  if (c.kind === 'location') {
    return (
      <button type="button" onClick={() => onGo(`/live?objectId=${c.objectId}`)} className="flex w-full items-start gap-2 rounded-lg border bg-muted/40 p-2 text-left hover:bg-muted">
        <MapPinIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <span className="min-w-0 text-xs">
          <span className="block font-medium">{c.address ?? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`}</span>
          <span className="text-muted-foreground">
            {[c.status && t(c.status), c.speedKph ? `${c.speedKph} km/h` : null, c.at ? formatDateTime(c.at) : null].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
    );
  }
  if (c.kind === 'stats') {
    if (!c.items.length) return null;
    return (
      <div className="grid grid-cols-2 gap-1.5">
        {c.items.map((s) => (
          <div key={s.label} className="rounded-lg border bg-muted/40 px-2 py-1.5">
            <div className="text-[11px] text-muted-foreground">{t(s.label)}</div>
            <div className="font-semibold tabular-nums">{s.value}</div>
          </div>
        ))}
      </div>
    );
  }
  if (!c.rows.length) return null;
  return (
    <div className="max-h-64 overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {c.columns.map((h) => (
              <th key={h} className="px-2 py-1 text-left font-medium">
                {t(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r, i) => (
            <tr key={i} className={cn('border-t', r.objectId && 'cursor-pointer hover:bg-muted/60')} onClick={() => r.objectId && onGo(`/live?objectId=${r.objectId}`)}>
              {r.cells.map((cell, j) => (
                <td key={j} className="px-2 py-1 tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
