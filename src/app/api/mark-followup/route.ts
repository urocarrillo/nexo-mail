/**
 * Endpoint llamado desde el botón "Marcar enviado" del mail semanal.
 * Actualiza col F o G del Sheet con la fecha de envío.
 *
 * Seguridad: query param ?token=... debe coincidir con FOLLOWUP_MARK_TOKEN.
 *
 * URL: /api/mark-followup?row=5&tipo=d7&token=XXX
 */
import { NextRequest, NextResponse } from 'next/server';
import { markFollowupSent } from '@/lib/sheets-followups';

const MARK_TOKEN = process.env.FOLLOWUP_MARK_TOKEN || '';

function htmlPage(title: string, message: string, color: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
</head>
<body style="margin:0; padding:60px 20px; font-family:Arial,Helvetica,sans-serif; background:#f4f4f4; min-height:100vh; box-sizing:border-box;">
<table width="500" align="center" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:500px;">
<tr><td style="background:${color}; padding:30px; text-align:center;">
  <h1 style="margin:0; font-size:24px; color:#ffffff; font-weight:700;">${title}</h1>
</td></tr>
<tr><td style="padding:30px; text-align:center;">
  <p style="margin:0 0 24px; font-size:16px; color:#313131; line-height:1.6;">${message}</p>
  <a href="https://docs.google.com/spreadsheets/d/1VPEiBjpqecXlTfqC0XN8bID1kSwkTs9CiLf53MgaQZo/edit" style="display:inline-block; background:#5ac8fa; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-size:14px; font-weight:700;">Abrir Sheet</a>
</td></tr>
<tr><td style="padding:16px 30px; border-top:1px solid #eee; text-align:center;">
  <p style="margin:0; font-size:12px; color:#999;">Nexo-mail · /api/mark-followup</p>
</td></tr>
</table>
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const rowParam = searchParams.get('row');
  const tipoParam = searchParams.get('tipo');

  if (!MARK_TOKEN || token !== MARK_TOKEN) {
    return new NextResponse(
      htmlPage('No autorizado', 'El link es inválido o expiró.', '#e74c3c'),
      { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  const row = Number(rowParam);
  if (!Number.isFinite(row) || row < 2) {
    return new NextResponse(
      htmlPage('Fila inválida', `No se encontró la fila ${rowParam}.`, '#e74c3c'),
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  if (tipoParam !== 'd7' && tipoParam !== 'd30') {
    return new NextResponse(
      htmlPage('Tipo inválido', `El tipo "${tipoParam}" no es válido. Tiene que ser d7 o d30.`, '#e74c3c'),
      { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }

  try {
    await markFollowupSent(row, tipoParam);
    const tipoLabel = tipoParam === 'd7' ? 'D+7' : 'D+30';
    return new NextResponse(
      htmlPage(
        '✓ Marcado como enviado',
        `Se registró el follow-up <strong>${tipoLabel}</strong> de la fila ${row} con fecha de hoy. El Sheet ya está actualizado.`,
        '#48c9b0'
      ),
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('mark-followup error:', msg);
    return new NextResponse(
      htmlPage('Error al actualizar', `No pude marcar la celda. Detalle: ${msg}`, '#e74c3c'),
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
