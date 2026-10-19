import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const KEYS_QUERY = ['developer', 'api-keys'] as const;
export const WEBHOOKS_QUERY = ['developer', 'webhooks'] as const;
export const deliveriesQuery = (endpointId: string) => ['developer', 'webhooks', endpointId, 'deliveries'] as const;

/** Copies `text` to the clipboard and confirms with a check mark. */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('Could not copy to the clipboard'));
    }
  };
  return (
    <Button type="button" variant="outline" size={label ? 'sm' : 'icon-sm'} className={className} onClick={() => void copy()} aria-label={label ?? t('Copy')}>
      {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      {label}
    </Button>
  );
}

/** A secret or code value in a monospace box with a copy button. */
export function SecretBox({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 rounded-lg border bg-muted/50 p-2', className)}>
      <code className="min-w-0 flex-1 font-mono text-xs break-all select-all">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}

/** Code block for the docs tab. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 pr-12 font-mono text-xs leading-relaxed">{code}</pre>
      <CopyButton text={code} className="absolute top-2 right-2" />
    </div>
  );
}
