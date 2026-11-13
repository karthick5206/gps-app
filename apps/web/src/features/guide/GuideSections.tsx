import type { GuideSection } from '@veetracer/shared';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';

/** Contents chips: one link per section (number prefix dropped). */
export function GuideContents({ sections }: { sections: readonly GuideSection[] }) {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('Contents')} className="mt-3 flex flex-wrap gap-2 text-sm">
      {sections.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="rounded-full border px-3 py-1 hover:bg-muted">
          {t(s.title).replace(/^\d+\.\s*/, '')}
        </a>
      ))}
    </nav>
  );
}

/** The sections as cards: numbered steps, monospace boxes for exact text (with Copy), then notes. */
export function GuideSectionCards({ sections }: { sections: readonly GuideSection[] }) {
  const { t } = useTranslation();
  return sections.map((s) => (
    <Card key={s.id} id={s.id} className="scroll-mt-20 space-y-3 p-5">
      <h2 className="text-lg font-semibold text-primary">{t(s.title)}</h2>
      {s.intro && <p className="text-sm text-muted-foreground">{s.intro}</p>}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {s.steps.map((st, i) => (
          <li key={i}>
            {st.text}
            {st.code && <CodeBox code={st.code} />}
          </li>
        ))}
      </ol>
      {s.notes?.length ? (
        <ul className="list-disc space-y-1 rounded-md bg-accent/50 py-2 pr-3 pl-8 text-xs text-muted-foreground">
          {s.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  ));
}

function CodeBox({ code }: { code: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="relative mt-1.5">
      <pre className="overflow-x-auto rounded-md bg-muted py-2 pr-16 pl-3 font-mono text-xs whitespace-pre">{code}</pre>
      <button
        type="button"
        onClick={copy}
        aria-label={t('Copy')}
        className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        {copied ? t('Copied') : t('Copy')}
      </button>
    </div>
  );
}
