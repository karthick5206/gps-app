import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { InvoiceLogo } from '../licences/invoice-pdf';
import { setupPdf } from '../reports/report-files';
import { setupSteps } from './claim-logic';
import { ShipmentRow } from './device-claim.service';

export interface HelpSheetSupport {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
}

/** Where the customer claims the device: the web app's claim page (QR target). */
export function claimUrl(appUrl: string, s: ShipmentRow): string {
  const code = (s.claimCode ?? '').replace('-', '');
  return `${appUrl.replace(/\/$/, '')}/claim?imei=${encodeURIComponent(s.uniqueId)}&code=${encodeURIComponent(code)}`;
}

/** One A5 page per device, packed in the box: identity, claim code + QR, how to add it, setup, support. */
export function helpSheetDocument(sheets: ShipmentRow[], appUrl: string, support: HelpSheetSupport, logo: InvoiceLogo | null): TDocumentDefinitions {
  const pages: Content[] = sheets.map((s, i) => {
    const url = claimUrl(appUrl, s);
    const head: Content[] = [];
    if (logo) head.push(logo.mime === 'image/svg+xml' ? { svg: logo.data.toString('utf8'), fit: [110, 40] } : { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [110, 40] });
    head.push({ text: 'Your tracker is ready', style: 'h1', margin: [0, logo ? 6 : 0, 0, 2] });
    const contact = [support.phone && `Phone / WhatsApp: ${support.phone}`, support.email && `Email: ${support.email}`, support.website].filter(Boolean).join('   ·   ');
    return {
      stack: [
        ...head,
        { text: s.reservedName ? `For ${s.reservedName}` : '', style: 'muted', margin: [0, 0, 0, 8] },
        {
          columns: [
            {
              width: '*',
              stack: [
                { text: [{ text: 'Device: ', style: 'label' }, s.modelName] },
                { text: [{ text: 'IMEI: ', style: 'label' }, { text: s.uniqueId, bold: true }] },
                { text: [{ text: 'Claim code: ', style: 'label' }, { text: s.claimCode ?? '—', style: 'code' }], margin: [0, 4, 0, 0] },
                { text: [{ text: 'Registered to: ', style: 'label' }, [s.reservedMobile, s.reservedEmail].filter(Boolean).join(' · ') || '—'], margin: [0, 4, 0, 0] },
              ],
            },
            { width: 'auto', stack: [{ qr: url, fit: 110 }, { text: 'Scan to add', style: 'muted', alignment: 'center', margin: [0, 2, 0, 0] }] },
          ],
          columnGap: 12,
        },
        { text: 'Add it to your account', style: 'h2' },
        {
          ol: [
            `Scan the QR code, or open ${appUrl.replace(/^https?:\/\//, '')}/claim and enter the IMEI and claim code.`,
            `Sign in, or create a personal account, with ${s.reservedEmail || s.reservedMobile || 'the email or mobile you gave us'}. The tracker is added to your account automatically.`,
            'Install the VeeTrax app on your phone to see it live, get alerts and play back trips.',
          ],
        },
        { text: 'Fitting and setup', style: 'h2' },
        { ul: setupSteps(s.protocol, s.modelName) },
        { text: 'Need help?', style: 'h2' },
        { text: `${support.name}${contact ? `\n${contact}` : ''}` },
        s.shipmentNote ? { text: s.shipmentNote, style: 'muted', margin: [0, 10, 0, 0] } : '',
      ],
      ...(i < sheets.length - 1 ? { pageBreak: 'after' as const } : {}),
    };
  });
  return {
    pageSize: 'A5',
    pageMargins: [28, 28, 28, 28],
    content: pages,
    defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.25 },
    styles: {
      h1: { fontSize: 16, bold: true, color: '#0f766e' },
      h2: { fontSize: 11, bold: true, margin: [0, 10, 0, 3], color: '#0f766e' },
      label: { color: '#555' },
      code: { fontSize: 14, bold: true, characterSpacing: 2 },
      muted: { color: '#666', fontSize: 8.5 },
    },
  };
}

export async function renderHelpSheet(sheets: ShipmentRow[], appUrl: string, support: HelpSheetSupport, logo: InvoiceLogo | null): Promise<Buffer> {
  setupPdf();
  return pdfmake.createPdf(helpSheetDocument(sheets, appUrl, support, logo)).getBuffer();
}
