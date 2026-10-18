import { MailIcon, XIcon } from 'lucide-react';
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { splitRecipients } from './report-format';

/** Email chips input: Enter / comma / space / paste add chips; Backspace on empty removes the last. Invalid text is kept with an error. */
export function RecipientChips({
  id,
  value,
  onChange,
  invalid,
  onInvalidChange,
  max = 50,
}: {
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  invalid?: boolean;
  /** Reports leftover text that isn't a valid email (so the form can block submit). */
  onInvalidChange?: (message: string | null) => void;
  max?: number;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const commit = (text: string): boolean => {
    const { added, invalid: bad } = splitRecipients(text, value);
    const room = Math.max(0, max - value.length);
    if (added.length) onChange([...value, ...added.slice(0, room)]);
    const leftover = bad.join(' ');
    setDraft(leftover);
    onInvalidChange?.(bad.length ? t('Not a valid email: {{emails}}', { emails: bad.join(', ') }) : added.length > room ? t('At most {{max}} recipients', { max }) : null);
    return !bad.length;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key)) {
      if (!draft.trim()) return;
      if (e.key !== 'Tab') e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[\s,;]/.test(text)) {
      e.preventDefault();
      commit(`${draft} ${text}`);
    }
  };

  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-2 py-1 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30',
        invalid && 'border-destructive',
      )}
      onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}
    >
      {value.map((email) => (
        <span key={email} className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary py-0.5 pr-1 pl-1.5 text-xs font-medium text-secondary-foreground">
          <MailIcon className="size-3 opacity-60" aria-hidden />
          <span className="truncate">{email}</span>
          <button type="button" aria-label={t('Remove {{email}}', { email })} onClick={() => onChange(value.filter((v) => v !== email))} className="rounded p-0.5 hover:bg-background/60">
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="email"
        inputMode="email"
        autoComplete="off"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!e.target.value) onInvalidChange?.(null);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => draft.trim() && commit(draft)}
        placeholder={value.length ? '' : 'name@company.com, …'}
        aria-invalid={invalid || undefined}
        className="h-7 min-w-40 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
