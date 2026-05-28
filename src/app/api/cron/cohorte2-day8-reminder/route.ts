import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const REMINDER_EMAIL = process.env.APPROVAL_EMAIL || '';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  BREVO_API_KEY
);

function buildHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<!-- Header -->
<tr><td style="background:#152735; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Cohorte 2 — Dia 8</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff; font-weight:700; line-height:1.3;">Revisar conversion Typeform + decidir A/B</h1>
</td></tr>

<!-- Accent line -->
<tr><td style="height:3px; background:linear-gradient(90deg,#5ac8fa,#48c9b0);"></td></tr>

<!-- Body -->
<tr><td style="padding:30px;">

  <p style="margin:0 0 20px; font-size:15px; line-height:1.6; color:#313131;">
    Hace 8 dias arrancamos pauta y venta de la cohorte 2 (31/05/2026). Hoy es el momento de revisar metricas y decidir si optimizamos el embudo (sumar camino ManyChat &rarr; email &rarr; Typeform como A/B).
  </p>

  <!-- Checklist metrico -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Metricas a revisar</h2>
  <ul style="padding-left:0; margin:0 0 24px; list-style:none;">
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Typeform</strong> &mdash; cuantas respuestas totales / completas / parciales (solo email)</li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Derivacion</strong> &mdash; cuantos cayeron en A1 / A2 / A3 / B / C</li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Checkout</strong> &mdash; cuantos compraron producto 3740 desde 31/05 (WooCommerce)</li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Tasa conversion</strong> &mdash; Typeform completo &rarr; compra</li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Zona gris</strong> &mdash; cuantos agendaron contacto / cuantos contactaste / resultado</li>
    <li style="margin-bottom:12px; font-size:15px; color:#313131;">&#9744; <strong>Pauta Meta</strong> &mdash; CPM, CTR, costo por lead (CPL), costo por compra (CPA)</li>
  </ul>

  <!-- Decision -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Decision a tomar</h2>
  <div style="background:#eef9fb; border-left:4px solid #5ac8fa; border-radius:4px; padding:16px 20px; margin-bottom:24px;">
    <p style="margin:0 0 8px; font-size:15px; line-height:1.6; color:#313131;">
      Si la tasa de completion del Typeform es baja (&lt;30%) o el CPL es alto:
    </p>
    <p style="margin:0; font-size:15px; line-height:1.6; color:#313131;">
      <strong>Sumar camino paralelo:</strong> Pauta &rarr; ManyChat (capta email solo) &rarr; email automatico con link al Typeform. A/B contra el camino directo actual. Asi capturas mail aunque no completen.
    </p>
  </div>

  <!-- Acciones -->
  <h2 style="margin:0 0 12px; font-size:18px; color:#152735; border-bottom:2px solid #5ac8fa; padding-bottom:8px;">Acciones tras revisar</h2>
  <ul style="padding-left:0; margin:0 0 20px; list-style:none;">
    <li style="margin-bottom:10px; font-size:15px; color:#313131;">&#9744; Actualizar README de cohorte-2 con los numeros</li>
    <li style="margin-bottom:10px; font-size:15px; color:#313131;">&#9744; Si conviene A/B: armar flow en ManyChat + plantilla Brevo con link al Typeform</li>
    <li style="margin-bottom:10px; font-size:15px; color:#313131;">&#9744; Si la pauta no rinde: ajustar creativos / audiencias (revisar insight NPS-IIEF)</li>
    <li style="margin-bottom:10px; font-size:15px; color:#313131;">&#9744; Si conversion es buena: dejar correr y planificar landing optimizada</li>
  </ul>

  <!-- Recordatorio docs -->
  <div style="background:#f8f9fa; border-radius:8px; padding:14px 18px; margin-top:24px;">
    <p style="margin:0; font-size:13px; line-height:1.5; color:#666666;">
      Docs relevantes en Obsidian: <code>cohorte-2/README.md</code>, <code>cohorte-2/typeforms/INDEX.md</code>, <code>cohorte-2/insight-nps-vs-iief-paradoja.md</code>
    </p>
  </div>

</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0; font-size:13px; color:#999999;">
    Nexo-mail &mdash; Recordatorio one-shot cohorte 2
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  if (now.getFullYear() !== 2026) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'one-shot reminder for 2026 only',
    });
  }

  try {
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.sender = { email: 'info@urologia.ar', name: 'Nexo-mail' };
    sendEmail.to = [{ email: REMINDER_EMAIL }];
    sendEmail.subject = 'Cohorte 2 — dia 8: revisar Typeform + decidir A/B ManyChat';
    sendEmail.htmlContent = buildHtml();

    const emailResult = await transacApi.sendTransacEmail(sendEmail);

    console.log(`Cohorte 2 day-8 reminder sent to ${REMINDER_EMAIL}`);

    return NextResponse.json({
      success: true,
      emailSent: true,
      messageId: emailResult.body?.messageId,
      timestamp: now.toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Cohorte 2 day-8 reminder cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
