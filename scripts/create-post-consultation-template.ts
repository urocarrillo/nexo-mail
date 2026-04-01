/**
 * Script to create the post-consultation email template in Brevo.
 * Run: npx tsx scripts/create-post-consultation-template.ts
 *
 * Template params (passed by Nexo-mail at send time):
 *   {{ params.NOMBRE }}      — patient first name
 *   {{ params.COUPON_CODE }} — unique coupon code (PAC-XXXXXX)
 */

import * as Brevo from '@getbrevo/brevo';

const BREVO_API_KEY = process.env.BREVO_API_KEY;

if (!BREVO_API_KEY) {
  console.error('Missing BREVO_API_KEY env var');
  process.exit(1);
}

const htmlContent = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;">

<!-- HEADER -->
<tr>
<td style="background-color:#152735;padding:24px 30px;text-align:center;">
  <span style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:0.5px;">Mauro Carrillo</span><br>
  <span style="color:rgba(255,255,255,0.85);font-size:13px;">Ur&oacute;logo | urologia.ar</span>
</td>
</tr>

<!-- ACCENT LINE -->
<tr>
<td style="height:3px;background:linear-gradient(90deg,#5ac8fa,#48c9b0);font-size:0;line-height:0;">&nbsp;</td>
</tr>

<!-- GREETING -->
<tr>
<td style="padding:35px 30px 20px;">
  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 16px;">
    Hola {{ params.NOMBRE }},
  </p>
  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 8px;">
    Fue un gusto atenderte hoy.
  </p>
  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0;">
    Como paciente m&iacute;o, ten&eacute;s acceso a algo que no ofrezco p&uacute;blicamente:
  </p>
</td>
</tr>

<!-- COUPON CODE BLOCK -->
<tr>
<td style="padding:0 30px 25px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f8ff;border:1px solid #5ac8fa;border-radius:8px;">
    <tr>
      <td style="padding:24px;text-align:center;">
        <p style="color:#E67E22;font-size:22px;font-weight:bold;margin:0 0 6px;">30% OFF</p>
        <p style="color:#666666;font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;">Tu c&oacute;digo exclusivo</p>
        <p style="color:#152735;font-size:28px;font-weight:bold;letter-spacing:2px;margin:0 0 12px;font-family:'Courier New',Courier,monospace;">{{ params.COUPON_CODE }}</p>
        <p style="color:#999999;font-size:13px;margin:0;">Uso &uacute;nico &middot; Solo para pacientes</p>
        <p style="color:#E67E22;font-size:16px;font-weight:bold;margin:12px 0 0;letter-spacing:0.5px;">&#9200; V&aacute;lido solo por 24 horas</p>
      </td>
    </tr>
  </table>
</td>
</tr>

<!-- INTRO TO CARDS -->
<tr>
<td style="padding:0 30px 20px;">
  <p style="color:#666666;font-size:15px;line-height:1.6;margin:0;">
    Aplic&aacute; tu c&oacute;digo en el checkout de cualquiera de estos cursos:
  </p>
</td>
</tr>

<!-- CARD 1: EP -->
<tr>
<td style="padding:0 30px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #5ac8fa;border-radius:4px;background-color:#ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <tr>
      <td style="padding:20px 24px;">
        <p style="color:#152735;font-size:17px;font-weight:bold;margin:0 0 10px;">Control&aacute; tu eyaculaci&oacute;n &mdash; Curso completo</p>
        <p style="color:#313131;font-size:15px;line-height:1.6;margin:0 0 16px;">
          Entend&eacute; por qu&eacute; te pasa y aprend&eacute; t&eacute;cnicas concretas para controlarlo. Ejercicios, h&aacute;bitos y estrategias que funcionan &mdash; a tu ritmo, desde tu casa.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background-color:#E67E22;border-radius:30px;text-align:center;">
              <a href="https://urologia.ar/cursos/control-eyaculacion-precoz/?utm_source=email&utm_medium=post-consulta&utm_campaign=cross-sell" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">Quiero acceder &rarr;</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
</tr>

<!-- CARD 2: PRESERVATIVO -->
<tr>
<td style="padding:0 30px 25px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #5ac8fa;border-radius:4px;background-color:#ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
    <tr>
      <td style="padding:20px 24px;">
        <p style="color:#152735;font-size:17px;font-weight:bold;margin:0 0 10px;">Manten&eacute; la erecci&oacute;n con preservativo &mdash; Curso completo</p>
        <p style="color:#313131;font-size:15px;line-height:1.6;margin:0 0 16px;">
          &iquest;Se te baja cuando te pon&eacute;s el preservativo? 8 m&oacute;dulos para transformar la ansiedad del momento en confianza. T&eacute;cnicas de anclaje sensorial, respiraci&oacute;n y entrenamiento p&eacute;lvico.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background-color:#E67E22;border-radius:30px;text-align:center;">
              <a href="https://urologia.ar/cursos/confianza-en-la-intimidad-secretos-para-mantener-la-ereccion-con-el-preservativo/?utm_source=email&utm_medium=post-consulta&utm_campaign=cross-sell" target="_blank" style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">Quiero acceder &rarr;</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td>
</tr>

<!-- CLOSING -->
<tr>
<td style="padding:0 30px 30px;">
  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0;">
    Gracias de nuevo por confiar en m&iacute;.<br>
    Record&aacute;: <strong style="color:#E67E22;">tu c&oacute;digo vence en 24 horas.</strong>
  </p>
</td>
</tr>

<!-- FOOTER -->
<tr>
<td style="background-color:#f8f9fa;padding:24px 30px;border-top:1px solid #e9ecef;">
  <p style="color:#313131;font-size:15px;font-weight:bold;margin:0 0 4px;">Mauro Carrillo</p>
  <p style="color:#666666;font-size:13px;margin:0 0 10px;">Ur&oacute;logo</p>
  <p style="color:#999999;font-size:12px;margin:0;"><a href="https://urologia.ar" style="color:#5ac8fa;text-decoration:none;">urologia.ar</a></p>
</td>
</tr>

</table>
</td></tr>
</table>
</body>
</html>`;

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
