/**
 * Script to create the post-consultation email template in Brevo.
 * Run: npx tsx scripts/create-post-consultation-template.ts
 *
 * Template params (passed by Nexo-mail at send time):
 *   {{ params.NOMBRE }}      — patient first name
 *   {{ params.COUPON_CODE }} — unique coupon code, Nombre + inicial (ej. CarlosD; legado PAC-XXXXXX)
 */

import * as Brevo from '@getbrevo/brevo';
import { htmlContent } from './post-consultation-template-html';

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('Missing BREVO_API_KEY env var');
  process.exit(1);
}


async function createTemplate() {
  const api = new Brevo.TransactionalEmailsApi();
  api.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY!);

  const template = new Brevo.CreateSmtpTemplate();
  template.templateName = 'Post-Consulta — Código Exclusivo Paciente';
  template.subject = '{{ params.NOMBRE }}, esto es solo para mis pacientes';
  template.htmlContent = htmlContent;
  template.sender = { name: 'Mauro Carrillo', email: 'info@urologia.ar' };
  template.replyTo = 'info@urologia.ar';
  template.isActive = true;

  try {
    const result = await api.createSmtpTemplate(template);
    const templateId = result.body?.id;
    console.log(`✅ Template created successfully!`);
    console.log(`   Template ID: ${templateId}`);
    console.log(`   Name: Post-Consulta — Código Exclusivo Paciente`);
    console.log(`\n⚠️  Add this to Vercel env vars:`);
    console.log(`   CALENDLY_EMAIL_TEMPLATE_ID=${templateId}`);
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: unknown }; message?: string };
    console.error('❌ Failed to create template:', apiError.response?.body || apiError.message);
    process.exit(1);
  }
}

createTemplate();
