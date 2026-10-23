import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { GUIDE_SECTIONS, GUIDE_TITLE } from '@veetracer/shared';
import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { MailerService } from '../auth/mailer.service';
import { loadEnv } from '../config/env';
import { InvoiceLogo } from '../licences/invoice-pdf';
import { LicenceSettingsService } from '../licences/licence-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { setupPdf } from '../reports/report-files';

export const GUIDE_PDF_NAME = 'VeeTrax-Getting-started.pdf';

/** The getting-started guide (shared GUIDE_SECTIONS) as an A4 PDF. */
export interface GuideUpi {
  vpa: string;
  payee: string;
  qr: InvoiceLogo | null;
}

export function guideDocument(appUrl: string, support: { name: string; phone: string | null; email: string | null }, logo: InvoiceLogo | null, upi: GuideUpi | null = null): TDocumentDefinitions {
  const content: Content[] = [];
  if (logo) content.push(logo.mime === 'image/svg+xml' ? { svg: logo.data.toString('utf8'), fit: [120, 44] } : { image: `data:${logo.mime};base64,${logo.data.toString('base64')}`, fit: [120, 44] });
  content.push({ text: GUIDE_TITLE, style: 'h1', margin: [0, logo ? 8 : 0, 0, 2] });
  content.push({ text: `Web: ${appUrl.replace(/^https?:\/\//, '')}   ·   Online guide: ${appUrl.replace(/^https?:\/\//, '')}/guide`, style: 'muted', margin: [0, 0, 0, 6] });
  for (const s of GUIDE_SECTIONS) {
    const block: Content[] = [{ text: s.title, style: 'h2' }];
    if (s.intro) block.push({ text: s.intro, margin: [0, 0, 0, 3] });
    block.push({
      ol: s.steps.map((st) => (st.code ? { stack: [st.text, { text: st.code, style: 'code', margin: [0, 2, 0, 2] }] } : st.text)),
    });
    if (s.notes?.length) block.push({ ul: s.notes.map((n) => ({ text: n, style: 'note' })), margin: [0, 3, 0, 0] });
    if (s.id === 'licences' && upi) {
      block.push({
        columns: [
          ...(upi.qr ? [{ width: 120, image: `data:${upi.qr.mime};base64,${upi.qr.data.toString('base64')}`, fit: [120, 140] as [number, number] }] : []),
          { width: '*', stack: [{ text: 'Pay by UPI or cash', bold: true }, `UPI ID: ${upi.vpa}`, `Name: ${upi.payee}`, { text: 'Scan with GPay, PhonePe, Paytm or BHIM. In VeeTrax → Billing & Licences → Buy you get a QR with the exact amount; after paying, enter the UTR / transaction ID there. No UPI? Choose Cash there and tell us whether you have paid or where to collect it. We activate your licences once the payment is received.', style: 'note' }] },
        ],
        columnGap: 12,
        margin: [0, 6, 0, 0],
      });
    }
    content.push({ stack: block, unbreakable: false });
  }
  const contact = [support.phone && `Phone / WhatsApp: ${support.phone}`, support.email && `Email: ${support.email}`].filter(Boolean).join('   ·   ');
  content.push({ text: 'Need help?', style: 'h2' }, { text: `${support.name}${contact ? `\n${contact}` : ''}` });
  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 44],
    content,
    footer: (page, pages) => ({ text: `${GUIDE_TITLE}  ·  ${page} / ${pages}`, alignment: 'center', style: 'muted', margin: [0, 14, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.3 },
    styles: {
      h1: { fontSize: 18, bold: true, color: '#0f766e' },
      h2: { fontSize: 12.5, bold: true, color: '#0f766e', margin: [0, 12, 0, 4] },
      code: { font: 'Roboto', fontSize: 9, background: '#eef6f5', color: '#134e4a', preserveLeadingSpaces: true },
      note: { fontSize: 9, color: '#444' },
      muted: { fontSize: 8.5, color: '#666' },
    },
  };
}

/** Getting-started guide: PDF download, and email (welcome on personal sign-up, or on request). */
@Injectable()
export class GuideService {
  private readonly logger = new Logger(GuideService.name);
  private readonly appUrl = loadEnv().webUrl;

  constructor(
    private readonly settings: LicenceSettingsService,
    private readonly mailer: MailerService,
    private readonly prisma: PrismaService,
  ) {}

  async pdf(): Promise<Buffer> {
    const s = await this.settings.get();
    setupPdf();
    const upi = s.upiId.trim() ? { vpa: s.upiId.trim(), payee: s.bankAccountName || s.legalName || 'VeeTrax', qr: await this.settings.upiQr() } : null;
    const doc = guideDocument(this.appUrl, { name: s.legalName || 'VeeTrax', phone: s.phone || null, email: s.email || null }, await this.settings.logo(), upi);
    return pdfmake.createPdf(doc).getBuffer();
  }

  /** Emails the guide PDF; `welcome` = the first email after a personal sign-up. */
  async email(to: string, name: string, welcome: boolean): Promise<void> {
    const url = this.appUrl.replace(/\/$/, '');
    const subject = welcome ? 'Welcome to VeeTrax — how to add your trackers' : 'VeeTrax getting-started guide';
    const lead = welcome ? `Welcome to VeeTrax, ${name}! Your account is ready.` : `Hi ${name}, here is the VeeTrax getting-started guide you asked for.`;
    const text =
      `${lead}\n\nThe attached guide shows how to:\n- start free, then buy licences\n- track a phone with the VeeTrax Tracker app\n- add a GPS tracker (sent by us or bought elsewhere)\n- add a dashcam\n- assign devices, set alerts and use the mobile app\n\n` +
      `Read it online: ${url}/guide\nSign in: ${url}\n\nReply to this email if you need help.`;
    const html =
      `<p>${escapeHtml(lead)}</p><p>The attached guide shows how to:</p><ul><li>start free, then buy licences</li><li>track a phone with the VeeTrax Tracker app</li>` +
      `<li>add a GPS tracker (sent by us or bought elsewhere)</li><li>add a dashcam</li><li>assign devices, set alerts and use the mobile app</li></ul>` +
      `<p><a href="${url}/guide">Read the guide online</a> · <a href="${url}">Sign in to VeeTrax</a></p><p style="color:#666">Reply to this email if you need help.</p>`;
    const s = await this.settings.get();
    const vpa = s.upiId.trim();
    const qr = vpa ? await this.settings.upiQr() : null;
    const upiText = vpa ? `

Buy licences: ${url}/admin/billing
Pay by UPI: ${vpa} (QR attached). After paying, enter the UTR in Billing & Licences. No UPI? Choose Cash there and tell us where to collect it.` : '';
    const upiHtml = vpa
      ? `<p><b>Buy licences:</b> <a href="${url}/admin/billing">Billing &amp; Licences</a>. Pay by UPI to <b>${escapeHtml(vpa)}</b>${qr ? ' (QR attached)' : ''}; after paying, enter the UTR / transaction ID there. No UPI app? Choose <b>Cash</b> there and tell us whether you have paid or where to collect it.</p>`
      : '';
    const attachments = [{ filename: GUIDE_PDF_NAME, content: await this.pdf(), contentType: 'application/pdf' }];
    if (qr) attachments.push({ filename: qr.mime === 'image/png' ? 'VeeTrax-UPI-QR.png' : 'VeeTrax-UPI-QR.jpg', content: qr.data, contentType: qr.mime });
    await this.mailer.send({ to, subject, text: text + upiText, html: html + upiHtml, attachments });
  }

  async emailUser(userId: string): Promise<{ ok: true; email: string }> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!u?.email) throw new NotFoundException('Your account has no email address. Add one in your profile first.');
    await this.email(u.email, u.name, false);
    return { ok: true, email: u.email };
  }

  /** After a personal sign-up: never fails the sign-up itself. */
  welcome(to: string, name: string): void {
    this.email(to, name, true).catch((e: Error) => this.logger.error(`Welcome email to ${to} failed: ${e.message}`));
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
