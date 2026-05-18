/**
 * Cron miércoles 8 AM AR (11:00 UTC):
 *   - Lee el Sheet de Sesiones 1-1
 *   - Detecta follow-ups pendientes (D+7 y D+30)
 *   - Manda 1 mail a Mauro con la lista + borradores listos para copy/paste
 *   - Botón "marcar enviado" por cada uno que actualiza el Sheet automáticamente
 */
import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';
import { readAllRows, findPending, type PendingFollowup } from '@/lib/sheets-followups';
import { generarBorrador } from '@/lib/followup-borrador';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const RECIPIENT = process.env.APPROVAL_EMAIL || '';
const MARK_TOKEN = process.env.FOLLOWUP_MARK_TOKEN || '';
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'https://nexo-mail.vercel.app';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1VPEiBjpqecXlTfqC0XN8bID1kSwkTs9CiLf53MgaQZo/edit';

const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

function urgenciaColor(u: PendingFollowup['urgencia']): { bg: string; text: string; label: string } {
  if (u === 'on-time') return { bg: '#fef1dd', text: '#E67E22', label: 'A tiempo' };
  if (u === 'late') return { bg: '#fbdcdc', text: '#c0392b', label: 'Demorado' };
  return { bg: '#e8e8e8', text: '#666666', label: 'Frío — decidir si igual escribir' };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildFollowupCard(p: PendingFollowup): string {
  const u = urgenciaColor(p.urgencia);
  const borrador = generarBorrador({
    nombre: p.row.nombre,
    tipo: p.tipo,
    diasDesdeSesion: p.diasDesdeSesion,
    notas: p.row.notas,
  });

  const tipoLabel = p.tipo === 'd7' ? 'Follow-up D+7' : 'Follow-up D+30';
  const sheetRowLink = `${SHEET_URL}?range=A${p.row.rowIndex}:H${p.row.rowIndex}`;
  const markLink = `${BASE_URL}/api/mark-followup?row=${p.row.rowIndex}&tipo=${p.tipo}&token=${encodeURIComponent(MARK_TOKEN)}`;
  const mailtoLink = `mailto:${encodeURIComponent(p.row.email)}?subject=${encodeURIComponent(borrador.subject)}&body=${encodeURIComponent(borrador.body)}`;

  return `
  <div style="border:1px solid #e0e0e0; border-radius:8px; padding:20px; margin-bottom:20px; background:#ffffff;">
    <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:8px;">
      <div>
        <h3 style="margin:0; font-size:18px; color:#152735;">${escapeHtml(p.row.nombre)} <span style="font-size:13px; color:#999;">(${escapeHtml(p.row.email)})</span></h3>
        <p style="margin:4px 0 0; font-size:13px; color:#666;">${tipoLabel} · Sesión hace ${p.diasDesdeSesion} días</p>
      </div>
      <span style="background:${u.bg}; color:${u.text}; padding:4px 10px; border-radius:12px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${u.label}</span>
    </div>

    ${p.row.notas ? `<div style="background:#f8f9fa; border-left:3px solid #5ac8fa; padding:8px 12px; margin:12px 0; font-size:13px; color:#444;"><strong style="color:#152735;">Notas:</strong> ${escapeHtml(p.row.notas)}</div>` : ''}

    <div style="background:#f8f9fa; border-radius:6px; padding:14px; margin:12px 0; font-family:Georgia,serif; font-size:14px; color:#313131; line-height:1.55; white-space:pre-wrap;"><strong style="font-family:Arial,sans-serif; font-size:12px; color:#152735; text-transform:uppercase; letter-spacing:0.6px; display:block; margin-bottom:8px;">Asunto:</strong>${escapeHtml(borrador.subject)}

<strong style="font-family:Arial,sans-serif; font-size:12px; color:#152735; text-transform:uppercase; letter-spacing:0.6px; display:block; margin:12px 0 8px;">Cuerpo:</strong>${escapeHtml(borrador.body)}</div>

    <div style="margin-top:16px;">
      <a href="${mailtoLink}" style="display:inline-block; background:#152735; color:#ffffff; text-decoration:none; padding:10px 20px; border-radius:6px; font-size:14px; font-weight:700; margin-right:8px; margin-bottom:8px;">📧 Abrir borrador en mail</a>
      <a href="${markLink}" style="display:inline-block; background:#48c9b0; color:#ffffff; text-decoration:none; padding:10px 20px; border-radius:6px; font-size:14px; font-weight:700; margin-right:8px; margin-bottom:8px;">✓ Marcar enviado</a>
      <a href="${sheetRowLink}" style="display:inline-block; background:#ffffff; color:#5ac8fa; text-decoration:none; padding:9px 20px; border-radius:6px; font-size:14px; font-weight:700; border:2px solid #5ac8fa; margin-bottom:8px;">📊 Ver en Sheet</a>
    </div>
  </div>`;
}

function buildEmail(pending: PendingFollowup[], dateStr: string): string {
  const total = pending.length;
  const d7Count = pending.filter((p) => p.tipo === 'd7').length;
  const d30Count = pending.filter((p) => p.tipo === 'd30').length;

  if (total === 0) {
    return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif; background:#f4f4f4; padding:20px 0; margin:0;">
<table width="600" align="center" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px;">
<tr><td style="background:#152735; padding:24px 30px;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Follow-ups programa</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff;">Semana del ${dateStr}</h1>
</td></tr>
<tr><td style="padding:30px;">
  <div style="background:#eefaf6; border-left:4px solid #48c9b0; padding:20px; border-radius:6px;">
    <p style="margin:0; font-size:16px; color:#152735;"><strong>Esta semana no hay follow-ups pendientes.</strong></p>
    <p style="margin:8px 0 0; font-size:14px; color:#666;">Ningún participante tiene sesión cerrada hace 7 o 30 días sin contactar.</p>
  </div>
  <div style="margin-top:24px; text-align:center;">
    <a href="${SHEET_URL}" style="display:inline-block; background:#5ac8fa; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:14px; font-weight:700;">Abrir Sheet de seguimiento</a>
  </div>
</td></tr>
<tr><td style="padding:16px 30px; border-top:1px solid #eee; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail · cron miércoles 8 AM</p>
</td></tr>
</table>
</body></html>`;
  }

  const cards = pending
    .sort((a, b) => {
      // Late primero, luego on-time, luego cold
      const order: Record<string, number> = { late: 0, 'on-time': 1, cold: 2 };
      return order[a.urgencia] - order[b.urgencia];
    })
    .map(buildFollowupCard)
    .join('');

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif; background:#f4f4f4; padding:20px 0; margin:0;">
<table width="700" align="center" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:700px;">

<tr><td style="background:#152735; padding:24px 30px;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Follow-ups del programa</p>
  <h1 style="margin:8px 0 0; font-size:24px; color:#ffffff;">Semana del ${dateStr}</h1>
</td></tr>

<tr><td style="height:3px; background:linear-gradient(90deg,#5ac8fa,#48c9b0);"></td></tr>

<tr><td style="padding:30px;">

  <div style="background:#f8f9fa; border-radius:8px; padding:20px; margin-bottom:24px;">
    <p style="margin:0 0 8px; font-size:15px; color:#152735;"><strong>Esta semana hay ${total} follow-up${total === 1 ? '' : 's'} pendiente${total === 1 ? '' : 's'}.</strong></p>
    <p style="margin:0; font-size:14px; color:#666;">${d7Count} de D+7 · ${d30Count} de D+30</p>
  </div>

  <p style="margin:0 0 16px; font-size:13px; color:#666; line-height:1.5;">
    Cada uno tiene un borrador armado con el tono que usás. Click en <strong>"Abrir borrador en mail"</strong> para personalizarlo y enviarlo desde Gmail. Después click en <strong>"Marcar enviado"</strong> y se actualiza solo en el Sheet.
  </p>

  ${cards}

  <div style="margin-top:24px; text-align:center;">
    <a href="${SHEET_URL}" style="display:inline-block; background:#5ac8fa; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:14px; font-weight:700;">Abrir Sheet completo</a>
  </div>

</td></tr>

<tr><td style="padding:16px 30px; border-top:1px solid #eee; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail · cron miércoles 8 AM · /api/cron/programa-followups</p>
</td></tr>

</table></body></html>`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('es-AR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows = await readAllRows();
    const pending = findPending(rows);
    const dateStr = formatDate(new Date());
    const html = buildEmail(pending, dateStr);

    const subject = pending.length === 0
      ? `Follow-ups programa — ${dateStr} · sin pendientes`
      : `Follow-ups programa — ${dateStr} · ${pending.length} pendiente${pending.length === 1 ? '' : 's'}`;

    const email = new Brevo.SendSmtpEmail();
    email.sender = { email: 'info@urologia.ar', name: 'Nexo-mail · Follow-ups' };
    email.to = [{ email: RECIPIENT }];
    email.subject = subject;
    email.htmlContent = html;

    const result = await transacApi.sendTransacEmail(email);

    console.log(
      `Programa follow-ups sent: ${pending.length} pending (${pending.filter(p => p.tipo==='d7').length} d7, ${pending.filter(p => p.tipo==='d30').length} d30)`
    );

    return NextResponse.json({
      success: true,
      pending: pending.length,
      d7: pending.filter((p) => p.tipo === 'd7').length,
      d30: pending.filter((p) => p.tipo === 'd30').length,
      messageId: result.body?.messageId,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('programa-followups cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
