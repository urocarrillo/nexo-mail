/**
 * HTML of Brevo template #158 — "Post-Consulta — Código Exclusivo Paciente".
 * Single source of truth. Shared by:
 *   - create-post-consultation-template.ts (initial creation)
 *   - update-post-consultation-template.ts (in-place updates to #158)
 *
 * Design: plain personal letter — no header, no footer, no cards.
 * Reads as if Mauro typed it after the consultation. Three orange buttons.
 * The coupon code sits ALONE in a dashed box (big, monospace, letter-spaced)
 * so a long-press on the phone selects only the code — nothing glued to it
 * (30/09/2026: a patient pasted it wrong when it was inline in a paragraph),
 * and repeated once more as plain bold text on its own line (Mauro's request).
 * No prices in the email (only the discount %), so it stays valid when
 * product prices change.
 *
 * Template params (passed by Nexo-mail at send time):
 *   {{ params.NOMBRE }}      — patient first name
 *   {{ params.COUPON_CODE }} — unique coupon code, Nombre + inicial (ej. CarlosD; legado PAC-XXXXXX)
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

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 18px;">Como agradecimiento te dejo algo que solo reciben mis pacientes: un <strong>30% de descuento</strong> en mis cursos y en el programa online. Este es tu c&oacute;digo:</p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
    <tr>
      <td align="center" style="background-color:#eef9fe;border:2px dashed #5ac8fa;border-radius:8px;padding:18px 16px;">
        <p style="color:#666666;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin:0 0 6px;">Tu c&oacute;digo de paciente</p>
        <p style="font-family:'Courier New',Courier,monospace;font-size:28px;font-weight:bold;letter-spacing:3px;color:#152735;margin:0;">{{ params.COUPON_CODE }}</p>
        <p style="color:#666666;font-size:13px;margin:8px 0 0;">Uso &uacute;nico &middot; vence en 24 horas</p>
      </td>
    </tr>
  </table>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 4px;">Tambi&eacute;n en texto simple, para copiarlo desde ac&aacute;:</p>
  <p style="color:#152735;font-size:18px;font-weight:bold;line-height:1.6;margin:0 0 18px;">{{ params.COUPON_CODE }}</p>

  <p style="color:#313131;font-size:16px;line-height:1.6;margin:0 0 28px;">Copialo y pegalo al momento de pagar en cualquiera de estos:</p>

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
