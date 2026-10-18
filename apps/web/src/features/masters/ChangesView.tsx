import { useTranslation } from 'react-i18next';

/** Renders an audit `changes` payload: `{before, after}` objects as a field diff, anything else as JSON. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function ChangesView({ changes }: { changes: unknown }) {
  const { t } = useTranslation();
  if (changes === null || changes === undefined) return null;
  if (isRecord(changes) && ('before' in changes || 'after' in changes)) {
    const before = isRecord(changes.before) ? changes.before : {};
    const after = isRecord(changes.after) ? changes.after : {};
    const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (!keys.length) return null;
    return (
      <div className="overflow-hidden rounded-lg border text-xs">
        <table className="w-full">
          <thead className="bg-muted/60 text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">{t('Field')}</th>
              <th className="px-2 py-1.5 text-left font-medium">{t('Before')}</th>
              <th className="px-2 py-1.5 text-left font-medium">{t('After')}</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k} className="border-t align-top">
                <td className="px-2 py-1.5 font-medium">{k}</td>
                <td className="px-2 py-1.5 break-all text-destructive/90 line-through decoration-destructive/40">{show(before[k])}</td>
                <td className="px-2 py-1.5 break-all text-success">{show(after[k])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 text-xs">{JSON.stringify(changes, null, 2)}</pre>;
}
