import { API_SCOPE_DEFS, WEBHOOK_EVENT_DEFS } from '@veetracer/shared';
import { ExternalLinkIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock } from './shared';
import { apiBase, CURL_COMMAND, CURL_POSITIONS, CURL_VEHICLES, ERROR_SAMPLE, RESPONSE_SAMPLE, VERIFY_NODE, VERIFY_PYTHON, WEBHOOK_SAMPLE } from './docs-snippets';

/** Endpoint reference: method, path, scope, notes (English developer reference). */
const ENDPOINTS: [string, string, string, string][] = [
  ['GET', '/v1/vehicles', 'read:vehicles', 'Vehicles with plate, type, branch and tracker IMEI. Paginated (limit ≤ 1000).'],
  ['GET', '/v1/vehicles/live', 'read:positions', 'Latest position, speed, ignition, status, cached address, odometer, fuel. ?vehicleIds=a,b'],
  ['GET', '/v1/vehicles/{id}/positions', 'read:positions', '?from&to (ISO, ≤ 7 days). Oldest first, limit ≤ 5000, cursor paging.'],
  ['GET', '/v1/trips', 'read:trips', '?from&to (≤ 31 days) &vehicleId. Trips that started in the range.'],
  ['GET', '/v1/stops', 'read:trips', 'Same filters as trips.'],
  ['GET', '/v1/alerts', 'read:alerts', '?from&to (≤ 31 days) &vehicleId &type=OVERSPEED,SOS'],
  ['GET', '/v1/reports/{type}', 'read:reports', 'summary, consolidated, distance, engine-hours, trips, stops, idle, halt, overspeed, ignition, alerts, event-summary, geofence-visits, geofence-summary, device-status, fuel, fuel-events. ?from&to=YYYY-MM-DD (≤ 31 days) &vehicleIds &period=DAY|WEEK|MONTH'],
  ['POST', '/v1/vehicles/{id}/commands', 'write:commands', '{"type":"locate|status|reboot"}. engine_stop / engine_resume need write:commands:critical and are refused while moving. 202.'],
  ['GET', '/v1/vehicles/{id}/commands', 'write:commands', 'Recent commands and their status (QUEUED, SENT, ACKED, FAILED, EXPIRED).'],
  ['GET · POST', '/v1/webhooks', 'webhooks', 'List or add webhook endpoints from your system.'],
  ['DELETE', '/v1/webhooks/{id}', 'webhooks', 'Remove an endpoint.'],
];

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;

export function DocsTab() {
  const { t } = useTranslation();
  const base = apiBase();
  return (
    <div className="grid gap-4">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {t('Reference for developers (in English).')}
        <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`${base}/v1/openapi.json`} target="_blank" rel="noreferrer">
          OpenAPI 3 (openapi.json) <ExternalLinkIcon className="size-3.5" />
        </a>
      </p>
      <Section heading={t('Authentication')}>
        <p>
          Send the key in the <Code>Authorization: Bearer vtx_live_…</Code> header on every request to <Code>{base}/v1/…</Code>. Keys only work on
          /api/v1 and user sign-in tokens do not work there. Use HTTPS; keep keys on your server, never in a browser or app.
        </p>
        <CodeBlock code={CURL_VEHICLES(base)} />
        <div className="grid gap-1.5">
          {API_SCOPE_DEFS.map((d) => (
            <div key={d.scope}>
              <Code>{d.scope}</Code> <span className="text-muted-foreground">— {d.description}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section heading={t('Endpoints')}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Method</TableHead>
              <TableHead>Path</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENDPOINTS.map(([m, p, s, n]) => (
              <TableRow key={`${m}${p}`}>
                <TableCell className="font-mono text-xs whitespace-nowrap">{m}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">{p}</TableCell>
                <TableCell className="font-mono text-xs whitespace-nowrap">{s}</TableCell>
                <TableCell className="min-w-64 text-xs">{n}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <CodeBlock code={CURL_POSITIONS(base)} />
        <CodeBlock code={CURL_COMMAND(base)} />
      </Section>
      <Section heading={t('Responses, pagination and errors')}>
        <p>
          Every response is JSON: <Code>{'{ data, meta }'}</Code>. Times are ISO 8601 in UTC; distances in km, speeds in km/h, durations in seconds.
          Lists are ordered oldest first; when <Code>meta.nextCursor</Code> is not null, pass it as <Code>?cursor=</Code> (with the same filters) to
          get the next page. Data is limited to the key's company, or its branch.
        </p>
        <CodeBlock code={RESPONSE_SAMPLE} />
        <p>
          Errors use <Code>{'{ error: { status, code, message } }'}</Code> with codes invalid_request (400), unauthorized (401), forbidden (403),
          not_found (404), rate_limited (429) and internal_error (500).
        </p>
        <CodeBlock code={ERROR_SAMPLE} />
      </Section>
      <Section heading={t('Rate limits')}>
        <p>
          Each key allows 60 requests per minute and 10,000 per day by default. Every response carries <Code>X-RateLimit-Limit</Code>,{' '}
          <Code>X-RateLimit-Remaining</Code> and the daily <Code>X-RateLimit-Limit-Day</Code> / <Code>X-RateLimit-Remaining-Day</Code>. Above the
          limit the API answers 429 with <Code>Retry-After</Code> (seconds). Prefer webhooks over frequent polling.
        </p>
      </Section>
      <Section heading={t('Webhooks')}>
        <p>
          VeeTrax POSTs JSON to your HTTPS endpoint within seconds of an event, with a 10 s timeout. Answer with any 2xx status; anything else (or a
          redirect, which is never followed) is retried after 1 min, 5 min, 30 min, 2 h and 6 h, then marked failed. After 50 failures in a row
          the endpoint is switched off and the admins are e-mailed. The same event keeps its <Code>id</Code> across retries and redeliveries, so
          use it to ignore duplicates.
        </p>
        <div className="grid gap-1.5">
          {WEBHOOK_EVENT_DEFS.map((d) => (
            <div key={d.event}>
              <Code>{d.event}</Code> <span className="text-muted-foreground">— {d.description}</span>
            </div>
          ))}
        </div>
        <CodeBlock code={WEBHOOK_SAMPLE} />
        <p>
          Verify <Code>X-VeeTrax-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</Code>: compute HMAC-SHA256 of <Code>{'"<t>.<raw body>"'}</Code>{' '}
          with the endpoint's signing secret, compare in constant time and reject timestamps older than 5 minutes.
        </p>
        <CodeBlock code={VERIFY_NODE} />
        <CodeBlock code={VERIFY_PYTHON} />
      </Section>
    </div>
  );
}
