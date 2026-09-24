/**
 * Sheet de leads del funnel "Firme y Seguro" (curso Erección con Preservativo).
 *
 * Spreadsheet: env FIRMESEGURO_SHEET_ID, tab "Leads".
 * Columnas:
 *   A Fecha (dd/mm/yyyy hh:mm ART) | B Nombre | C Email | D Fuente |
 *   E Secuencia | F Estado seguimiento | G Cliente | H Notas
 *
 * Auth: mismo service account de Google que sheets-sesiones (google-auth).
 * Todas las funciones son best-effort: nunca lanzan (el funnel no debe caerse
 * por un problema del Sheet); loguean el error y devuelven ok:false / void.
 */
import { getGoogleAccessToken } from './google-auth';

const SHEET_ID = process.env.FIRMESEGURO_SHEET_ID || '';
const TAB_NAME = 'Leads';
const ART_OFFSET_HOURS = -3;

/** dd/mm/yyyy hh:mm del instante `d` en hora ART (UTC-3). */
function fechaArtCompleta(d: Date): string {
  const art = new Date(d.getTime() + ART_OFFSET_HOURS * 60 * 60 * 1000);
  const dd = String(art.getUTCDate()).padStart(2, '0');
  const mm = String(art.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = art.getUTCFullYear();
  const hh = String(art.getUTCHours()).padStart(2, '0');
  const mi = String(art.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

async function getValues(range: string, token: string): Promise<string[][]> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firme-seguro sheet read failed (${res.status}) [${range}]: ${err}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values || [];
}

async function updateCells(
  updates: Array<{ range: string; value: string }>,
  token: string
): Promise<void> {
  if (updates.length === 0) return;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firme-seguro sheet batchUpdate failed (${res.status}): ${err}`);
  }
}

/**
 * Fila (1-based) del email en la columna C, o null si no está.
 * Primera coincidencia, comparación normalizada (lowercase + trim).
 */
async function findRowByEmail(email: string, token: string): Promise<number | null> {
  const target = email.toLowerCase().trim();
  const values = await getValues(`${TAB_NAME}!C:C`, token);
  for (let i = 0; i < values.length; i++) {
    if ((values[i][0] || '').toLowerCase().trim() === target) return i + 1;
  }
  return null;
}

/**
 * Registra un lead nuevo en el Sheet (append con dedupe por email en col C).
 * Best-effort: nunca lanza; devuelve ok:false si algo falló.
 */
export async function logLeadFirmeSeguro(data: {
  nombre: string;
  email: string;
  fuente: string;
}): Promise<{ ok: boolean; duplicate?: boolean }> {
  try {
    if (!SHEET_ID) throw new Error('FIRMESEGURO_SHEET_ID not configured');
    const token = await getGoogleAccessToken();

    // Dedupe: una fila por lead. Si el email ya está en la columna C, no
    // volver a agregarlo (el lead puede re-enviar el formulario).
    if ((await findRowByEmail(data.email, token)) !== null) {
      return { ok: true, duplicate: true };
    }

    const range = encodeURIComponent(`${TAB_NAME}!A:H`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const row = [
      fechaArtCompleta(new Date()),
      data.nombre,
      data.email.toLowerCase().trim(),
      data.fuente,
      '', // E Secuencia
      '', // F Estado seguimiento
      '', // G Cliente
      '', // H Notas
    ];

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Firme-seguro sheet append failed (${res.status}): ${err}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('Firme-seguro sheet log error (non-blocking):', err);
    return { ok: false };
  }
}

/**
 * Agrega una marca a la columna E (Secuencia) de la fila del email
 * (ej: "fs2 enviado 24/07"). Concatena con " · " si ya hay algo.
 * Best-effort: nunca lanza; si el email no está en el Sheet, no hace nada.
 */
export async function markSecuenciaFirmeSeguro(email: string, marca: string): Promise<void> {
  try {
    if (!SHEET_ID) return;
    const token = await getGoogleAccessToken();
    const row = await findRowByEmail(email, token);
    if (row === null) return;

    const current = ((await getValues(`${TAB_NAME}!E${row}`, token))[0]?.[0] || '').trim();
    const value = current ? `${current} · ${marca}` : marca;
    await updateCells([{ range: `${TAB_NAME}!E${row}`, value }], token);
  } catch (err) {
    console.error('Firme-seguro sheet secuencia mark error (non-blocking):', err);
  }
}

/**
 * Marca al lead como cliente: escribe la columna G (Cliente) con `texto`
 * (ej: "curso preservativo 23/07/2026") y pone "COMPRÓ" en F (Estado
 * seguimiento). Best-effort: nunca lanza; si el email no está, no hace nada.
 */
export async function markClienteFirmeSeguro(email: string, texto: string): Promise<void> {
  try {
    if (!SHEET_ID) return;
    const token = await getGoogleAccessToken();
    const row = await findRowByEmail(email, token);
    if (row === null) return;

    await updateCells(
      [
        { range: `${TAB_NAME}!G${row}`, value: texto },
        { range: `${TAB_NAME}!F${row}`, value: 'COMPRÓ' },
      ],
      token
    );
  } catch (err) {
    console.error('Firme-seguro sheet cliente mark error (non-blocking):', err);
  }
}
