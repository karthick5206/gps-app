/**
 * Sends one system alert through the app's own mail provider (Zoho / SMTP from .env) and, optionally, SMS — for the
 * Windows watchdog, which must alert even when the API (and so System Health's own e-mails) is down.
 *
 *   node dist/monitoring/alert-cli.js --subject "Cache down" --body "Memurai service stopped at 10:02"
 *
 * Recipients: SYSTEM_ALERT_EMAILS, else the Super Admin from PostgreSQL (3 s timeout).
 * SMS (optional): SYSTEM_ALERT_SMS (comma-separated E.164 numbers) with SYSTEM_ALERT_SMS_DLT_TEMPLATE_ID — Indian
 * gateways only deliver DLT-registered templates, so nothing is sent without one.
 * Exit code 0 when at least one channel delivered, 1 otherwise.
 */
import { PrismaClient } from '@prisma/client';
import { hostname } from 'node:os';
import { MailerService } from '../auth/mailer.service';
import { loadEnv } from '../config/env';
import { createSmsProvider } from '../notifier/sms';
import { withTimeout } from './util';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function superAdminEmail(): Promise<string | null> {
  const prisma = new PrismaClient();
  try {
    const user = await withTimeout(prisma.user.findFirst({ where: { isSuperAdmin: true }, select: { email: true } }), 3000, 'PostgreSQL');
    return user?.email ?? null;
  } catch {
    return null;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  loadEnv();
  const subject = `[VeeTrax] ${arg('subject') ?? 'System alert'}`.slice(0, 150);
  const body = arg('body') ?? '';
  const text = `${body}\n\nSent by the VeeTrax watchdog on ${hostname()} at ${new Date().toUTCString()}.`;
  let delivered = 0;

  const listed = (process.env.SYSTEM_ALERT_EMAILS ?? '').split(',').map((s) => s.trim()).filter((s) => /.+@.+\..+/.test(s));
  const to = listed.length ? listed : [await superAdminEmail()].filter((e): e is string => !!e);
  const mailer = new MailerService();
  for (const address of to) {
    try {
      await mailer.send({ to: address, subject, text, html: `<pre style="font-family:Arial,Helvetica,sans-serif;white-space:pre-wrap">${esc(text)}</pre>` });
      delivered++;
    } catch (error) {
      console.error(`mail to ${address} failed: ${(error as Error).message}`);
    }
  }

  const numbers = (process.env.SYSTEM_ALERT_SMS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const template = process.env.SYSTEM_ALERT_SMS_DLT_TEMPLATE_ID?.trim();
  if (numbers.length && template) {
    const sms = createSmsProvider();
    for (const number of numbers) {
      try {
        await sms.send({ to: number, text: `${subject} ${body}`.slice(0, 300), dltTemplateId: template, variables: [`${subject} ${body}`.slice(0, 30)] });
        delivered++;
      } catch (error) {
        console.error(`SMS to ${number} failed: ${(error as Error).message}`);
      }
    }
  }
  if (!to.length) console.error('No recipient: set SYSTEM_ALERT_EMAILS in .env');
  console.log(`alert "${subject}": ${delivered} delivered`);
  return delivered > 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
