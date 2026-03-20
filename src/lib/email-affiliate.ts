import * as Brevo from '@getbrevo/brevo';

const smtpApi = new Brevo.TransactionalEmailsApi();
smtpApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

export async function sendAffiliateWelcomeEmail(params: {
  email: string;
  nombre: string;
  link: string;
  comision_pct: number;
}): Promise<void> {
  const { email, nombre, link, comision_pct } = params;

  const sendEmail = new Brevo.SendSmtpEmail();
  sendEmail.sender = { name: 'Urólogo Mauro Carrillo', email: 'info@urologia.ar' };
  sendEmail.to = [{ email, name: nombre }];
  sendEmail.subject = 'Tu link de afiliado — urologia.ar';
  sendEmail.htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#313131;">
      <div style="background:#152735;padding:30px;text-align:center;">
        <h1 style="color:#fff;font-size:22px;margin:0;">Programa de Afiliados</h1>
        <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:8px 0 0;">urologia.ar</p>
      </div>
      <div style="height:3px;background:#5ac8fa;"></div>
      <div style="padding:30px;">
        <p>Hola <strong>${nombre}</strong>,</p>
        <p>Gracias por sumarte como afiliado. Acá tenés tu link personal:</p>
        <div style="background:#f4f4f4;border-left:4px solid #5ac8fa;padding:16px 20px;margin:20px 0;border-radius:0 6px 6px 0;">
          <a href="${link}" style="color:#152735;font-weight:bold;font-size:16px;word-break:break-all;text-decoration:none;">${link}</a>
        </div>
        <p>Cada vez que alguien compre a través de tu link, ganás el <strong>${comision_pct}%</strong> de la venta. El seguimiento es automático.</p>
        <p>Compartilo con tus pacientes o tu audiencia cuando lo consideres oportuno.</p>
        <p style="margin-top:24px;">Un abrazo,</p>
        <p><strong>Urólogo Mauro Carrillo</strong><br><span style="color:#999;font-size:13px;">urologia.ar</span></p>
      </div>
    </div>
  `;

  await smtpApi.sendTransacEmail(sendEmail);
}

export async function sendAffiliateSaleNotification(params: {
  orderId: string;
  total: string;
  currency: string;
  affiliateCode: string;
  affiliateName: string;
  commission: number;
}): Promise<void> {
  const { orderId, total, currency, affiliateCode, affiliateName, commission } = params;

  const sendEmail = new Brevo.SendSmtpEmail();
  sendEmail.sender = { name: 'Nexo-mail', email: 'info@urologia.ar' };
  sendEmail.to = [{ email: 'info@urologia.ar', name: 'Mauro Carrillo' }];
  sendEmail.subject = `Venta con referido — ${affiliateCode.toUpperCase()} — Pedido #${orderId}`;
  sendEmail.htmlContent = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;color:#313131;">
      <div style="background:#152735;padding:20px;text-align:center;">
        <h2 style="color:#fff;font-size:18px;margin:0;">Nueva venta con referido</h2>
      </div>
      <div style="height:3px;background:#48c9b0;"></div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#666;">Pedido</td><td style="padding:8px 0;font-weight:bold;">#${orderId}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Monto</td><td style="padding:8px 0;font-weight:bold;">${total} ${currency}</td></tr>
          <tr><td style="padding:8px 0;color:#666;">Referido por</td><td style="padding:8px 0;font-weight:bold;">${affiliateCode.toUpperCase()} (${affiliateName})</td></tr>
          <tr style="background:#eefaf6;"><td style="padding:10px 8px;color:#48c9b0;font-weight:bold;">Comisión</td><td style="padding:10px 8px;font-weight:bold;color:#48c9b0;">$${commission.toFixed(2)} ${currency}</td></tr>
        </table>
      </div>
    </div>
  `;

  await smtpApi.sendTransacEmail(sendEmail);
}
