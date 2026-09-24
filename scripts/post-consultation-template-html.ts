/**
 * HTML of Brevo template #158 — "Post-Consulta — Código Exclusivo Paciente".
 * Single source of truth. Shared by:
 *   - create-post-consultation-template.ts (initial creation)
 *   - update-post-consultation-template.ts (in-place updates to #158)
 *
 * Design: plain personal letter — no header, no footer, no cards.
 * Reads as if Mauro typed it after the consultation. Three orange buttons.
 * No prices in the email (only the discount %), so it stays valid when
 * product prices change.
 *
 * Template params (passed by Nexo-mail at send time):
 *   {{ params.NOMBRE }}      — patient first name
 *   {{ params.COUPON_CODE }} — unique coupon code (PAC-XXXXXX)
 *
 * Links carry ?cupon={{ params.COUPON_CODE }} — a JS snippet on urologia.ar
 * (Elementor Custom Code "Cupón PAC: auto-aplicar en carrito") stores it and
 * auto-applies it at cart/checkout via the WooCommerce Store API.
 */

export const TEMPLATE_ID = 158;

export const subject = 'Gracias por la consulta, {{ params.NOMBRE }}';

export const sender = { name: 'Mauro', email: 'mauro@urologia.ar' };

export const replyTo = 'mauro@urologia.ar';

const UTM = 'utm_source=email&utm_medium=post-consulta&utm_campaign=cross-sell';

const boton = (url: string, label: string) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 0;">
  <tr>
    <td style="background-color:#E67E22;border-radius:30px;text-align:center;">
      <a href="${url}?cupon={{ params.COUPON_CODE }}&${UTM}" target="_blank" style="display:inline-block;padding:12px 30px;color:#ffffff;font-size:15px;font-weight:bold;text-decoration:none;">${label}</a>
    </td>
  </tr>
</table>`;

export const htmlContent = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">
<tr><td align="center" style="padding:20px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;max-width:600px;">
<tr>
<td style="padding:40px 35px;">

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 16px;">Hola {{ params.NOMBRE }},</p>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 16px;">Gracias por la confianza de hoy.</p>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 28px;">Como agradecimiento te dejo algo que solo reciben mis pacientes: el c&oacute;digo <strong style="font-family:'Courier New',Courier,monospace;font-size:17px;">{{ params.COUPON_CODE }}</strong>, con un <strong>30% de descuento</strong> en mis cursos y en el programa online. Es de uso &uacute;nico y vence en 24 horas. Copialo y pegalo al momento de pagar en cualquiera de estos:</p>

  <p style="color:#152735;font-size:17px;font-weight:bold;margin:0 0 8px;">Controla tu Mente, Recupera tu Erecci&oacute;n</p>
  <p style="color:#313131;font-size:15px;line-height:1.6;margin:0;">El programa de 8 semanas para superar la ansiedad de desempe&ntilde;o y volver a tener erecciones firmes, sin pastillas. T&eacute;cnicas de mente y cuerpo en video, gu&iacute;as descargables y una consulta 1-1 conmigo incluida para revisar tu caso.</p>
  ${boton('https://urologia.ar/recuperatuereccion/', 'Ver el programa')}

  <p style="color:#152735;font-size:17px;font-weight:bold;margin:32px 0 8px;">Control&aacute; tu Eyaculaci&oacute;n</p>
  <p style="color:#313131;font-size:15px;line-height:1.6;margin:0;">El curso completo para aprender a durar m&aacute;s: t&eacute;cnicas paso a paso, ejercicios y h&aacute;bitos concretos para controlar la eyaculaci&oacute;n y disfrutar sin ansiedad, sin f&aacute;rmacos.</p>
  ${boton('https://urologia.ar/controla-tu-eyaculacion/', 'Ver el curso')}

  <p style="color:#152735;font-size:17px;font-weight:bold;margin:32px 0 8px;">Combo: Programa + Curso</p>
  <p style="color:#313131;font-size:15px;line-height:1.6;margin:0;">Los dos juntos, con la consulta 1-1 incluida. Si te interesan ambos temas, con tu c&oacute;digo es por lejos la opci&oacute;n que m&aacute;s conviene.</p>
  ${boton('https://urologia.ar/experto-en-intimidad/', 'Ver el combo')}

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:32px 0 16px;">Sea cual sea el que elijas, avanz&aacute;s a tu ritmo y en total privacidad. Y si tu consulta fue por otro tema, quiz&aacute;s ac&aacute; encuentres la soluci&oacute;n a algo que ven&iacute;as postergando.</p>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 16px;">Si dud&aacute;s cu&aacute;l va con tu caso, respondeme este mail y lo vemos.</p>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0;">Un abrazo.<br>Mauro</p>

</td>
</tr>
</table>
</td></tr>
</table>
</body>
</html>`;
