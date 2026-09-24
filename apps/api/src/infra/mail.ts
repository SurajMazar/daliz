import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ENV, type Env } from '../config/env.js';
import type { EmailTemplate } from './queue.js';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const HEX = /^#[0-9a-f]{6}$/;

interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface Branding {
  brandName: string;
  primaryColor: string;
  logoUrl: string | null;
}

function layout(b: Branding, heading: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const color = HEX.test(b.primaryColor) ? b.primaryColor : '#2753d7';
  const logo = b.logoUrl
    ? `<img src="${escapeHtml(b.logoUrl)}" alt="${escapeHtml(b.brandName)}" style="max-height:40px;max-width:200px;display:block;margin-bottom:24px" />`
    : `<div style="font-weight:700;font-size:18px;margin-bottom:24px">${escapeHtml(b.brandName)}</div>`;
  const button = action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="background:${color};color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(action.label)}</a></p>
       <p style="color:#555;font-size:13px">If the button doesn't work, paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(action.url)}</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <div style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
      ${logo}
      <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
      ${paragraphs.map((p) => `<p style="line-height:1.55;margin:0 0 12px">${escapeHtml(p)}</p>`).join('')}
      ${button}
    </div>
    <p style="color:#6b7280;font-size:12px;text-align:center;margin-top:16px">Sent by ${escapeHtml(b.brandName)} via Daliz.</p>
  </div></body></html>`;
}

/** Renders templates. All interpolated values are HTML-escaped. */
export function renderEmail(template: EmailTemplate, data: Record<string, string>): RenderedEmail {
  const b: Branding = {
    brandName: data.brandName || 'Daliz',
    primaryColor: data.primaryColor || '#2753d7',
    logoUrl: data.logoUrl || null,
  };
  const text = (lines: string[]) => lines.join('\n\n');
  switch (template) {
    case 'invitation': {
      const heading = `You're invited to ${data.workspaceName}`;
      const body = [
        `${data.inviterName || 'An administrator'} invited you to join ${data.workspaceName} on ${b.brandName}.`,
        `This invitation expires on ${data.expiresAt}.`,
      ];
      return {
        subject: heading,
        html: layout(b, heading, body, { label: 'Accept invitation', url: data.url! }),
        text: text([heading, ...body, data.url!]),
      };
    }
    case 'password_reset': {
      const heading = 'Reset your password';
      const body = [
        'We received a request to reset your password. The link below is valid for 30 minutes and can be used once.',
        "If you didn't request this, you can ignore this email; your password won't change.",
      ];
      return {
        subject: heading,
        html: layout(b, heading, body, { label: 'Choose a new password', url: data.url! }),
        text: text([heading, ...body, data.url!]),
      };
    }
    case 'email_verification': {
      const heading = 'Confirm your email address';
      const body = ['Confirm this address to finish setting up your account.'];
      return {
        subject: heading,
        html: layout(b, heading, body, { label: 'Confirm email', url: data.url! }),
        text: text([heading, ...body, data.url!]),
      };
    }
    case 'password_changed': {
      const heading = 'Your password was changed';
      const body = [
        `The password for ${data.email} was changed on ${data.when}.`,
        'If this wasn’t you, reset your password immediately and contact your administrator.',
      ];
      return { subject: heading, html: layout(b, heading, body), text: text([heading, ...body]) };
    }
    case 'mfa_changed': {
      const heading = `Two-factor authentication ${data.change}`;
      const body = [
        `Two-factor authentication was ${data.change} for ${data.email} on ${data.when}.`,
        'If this wasn’t you, reset your password immediately and contact your administrator.',
      ];
      return { subject: heading, html: layout(b, heading, body), text: text([heading, ...body]) };
    }
    case 'notification': {
      const heading = data.title ?? 'You have a new notification';
      const body = data.body ? [data.body] : [];
      return {
        subject: heading,
        html: layout(b, heading, body, { label: 'Open in Daliz', url: data.url! }),
        text: text([heading, ...body, data.url!]),
      };
    }
    case 'new_login': {
      const heading = 'New sign-in to your account';
      const body = [
        `A new sign-in to ${data.email} happened on ${data.when}.`,
        `Device: ${data.userAgent || 'unknown'}. IP address: ${data.ip || 'unknown'}.`,
        'If this wasn’t you, sign out of all sessions and change your password.',
      ];
      return { subject: heading, html: layout(b, heading, body), text: text([heading, ...body]) };
    }
  }
}

@Injectable()
export class MailSender {
  private readonly transport: Transporter;
  private readonly logger = new Logger(MailSender.name);

  constructor(@Inject(ENV) private readonly env: Env) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }

  async send(to: string, template: EmailTemplate, data: Record<string, string>): Promise<void> {
    const rendered = renderEmail(template, data);
    await this.transport.sendMail({ from: this.env.MAIL_FROM, to, ...rendered });
    // Never log tokens/links; the template name and recipient domain are enough.
    this.logger.log({ template, toDomain: to.split('@')[1] }, 'email sent');
  }
}
