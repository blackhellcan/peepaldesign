// Outgoing email: sign-in links and project invitations. SMTP covers any provider
// (SES, Postmark, Resend, Mailgun…); `log` prints the message for local development
// only, and is refused when hosted because it would put sign-in links in the logs.
export type Mail = {to: string; subject: string; text: string; html: string};
export type Mailer = {send(mail: Mail): Promise<void>};

export async function createMailer({mode, smtpUrl, from}: {mode: 'smtp' | 'log'; smtpUrl?: string; from?: string}): Promise<Mailer> {
  if (mode === 'log') return {async send(mail) { process.stderr.write(`\n[mail to ${mail.to}] ${mail.subject}\n${mail.text}\n\n`); }};
  const {default: nodemailer} = await import('nodemailer');
  const transport = nodemailer.createTransport(smtpUrl!);
  return {async send(mail) { await transport.sendMail({from, ...mail}); }};
}

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export function linkMail(to: string, subject: string, intro: string, url: string, note: string): Mail {
  return {to, subject, text: `${intro}\n\n${url}\n\n${note}`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#1f2937;max-width:520px;margin:24px auto;padding:0 16px">
<p>${escape(intro)}</p><p><a href="${escape(url)}" style="display:inline-block;background:#0b5fd6;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Sign in to GapScan</a></p>
<p style="color:#6b7280;font-size:13px">${escape(note)}</p></body></html>`};
}
