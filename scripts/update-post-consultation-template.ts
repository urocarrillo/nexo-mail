/**
 * Update Brevo template #158 in place with the HTML, subject and sender from
 * post-consultation-template-html.ts (single source of truth).
 * Run: BREVO_API_KEY=... npx tsx scripts/update-post-consultation-template.ts
 */

import * as Brevo from '@getbrevo/brevo';
import { htmlContent, subject, sender, replyTo, TEMPLATE_ID } from './post-consultation-template-html';

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('Missing BREVO_API_KEY env var');
  process.exit(1);
}

async function updateTemplate() {
  const api = new Brevo.TransactionalEmailsApi();
  api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY!);

  const template = new Brevo.UpdateSmtpTemplate();
  template.htmlContent = htmlContent;
  template.subject = subject;
  template.sender = sender;
  template.replyTo = replyTo;

  try {
    await api.updateSmtpTemplate(TEMPLATE_ID, template);
    console.log(`✅ Template #${TEMPLATE_ID} updated (html + subject + sender + replyTo)`);
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: unknown }; message?: string };
    console.error('❌ Failed to update template:', apiError.response?.body || apiError.message);
    process.exit(1);
  }
}

updateTemplate();
