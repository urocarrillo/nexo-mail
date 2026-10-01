/**
 * Sheet "TikTok PROGRAMA Form" — leads pre-test del programa DE.
 *
 * Spreadsheet: env TIKTOK_PROGRAMA_SHEET_ID (fallback hardcodeado, ver PRD
 * prd-tiktok-manychat-recupera-form). Primera pestaña (gid 0).
 * Columnas:
 *   A NOMBRE | B id de contacto | C tiempo | D mail |
 *   E mail_enviado | F fecha_mail_enviado | G completo_form | H fecha_completo_form
 *
 * Las filas viejas de ManyChat las escribía ManyChat y las procesaba el Apps
 * Script del sheet (onChange → POST a /api/webhook/tiktok-form). Las filas de
 * /api/form/programa (landing web y DMs de ManyChat) las escribe este lib
 * DESPUÉS de enviar el mail, con E=SUCCESS, para que el Apps Script nunca las
 * reprocese (evita mail duplicado). Col B: id de contacto de ManyChat si vino
 * (DM), si no `bio-<source>`.
 *
 * Best-effort: nunca lanza; loguea el error y devuelve ok:false.
 */
import { getGoogleAccessToken } from './google-auth';

const SHEET_ID =
  process.env.TIKTOK_PROGRAMA_SHEET_ID || '1UT9S4EHK-yhoK7i1mF-gucgjFhDKS21HB2B9h8rW6WI';
const ART_OFFSET_HOURS = -3;

let cachedTabTitle: string | null = null;

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

/** Título de la primera pestaña (gid 0), cacheado por instancia. */
async function getTabTitle(token: string): Promise<string> {
  if (cachedTabTitle) return cachedTabTitle;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok sheet metadata failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const first =
    data.sheets?.find((s) => s.properties?.sheetId === 0) || data.sheets?.[0];
  const title = first?.properties?.title;
  if (!title) throw new Error('TikTok sheet: no tab found');
  cachedTabTitle = title;
  return title;
}

/** Fila (1-based) del email en la columna D, o null si no está. */
async function findRowByEmail(email: string, tab: string, token: string): Promise<number | null> {
  const target = email.toLowerCase().trim();
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${tab}!D:D`)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok sheet read failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  const values = data.values || [];
  for (let i = 0; i < values.length; i++) {
    if ((values[i][0] || '').toLowerCase().trim() === target) return i + 1;
  }
  return null;
}

/**
 * Registra un lead de la landing web con el mail ya enviado (E=SUCCESS).
 * Dedupe por email en col D: si ya existe, no agrega fila (el mail se reenvió
 * igual desde el endpoint, pero el sheet mantiene una fila por lead).
 */
export async function logLeadProgramaWeb(data: {
  nombre: string;
  email: string;
  source: string;
  /** {Id de contacto} de ManyChat (leads por DM). */
  idContacto?: string;
}): Promise<{ ok: boolean; duplicate?: boolean }> {
  try {
    if (!SHEET_ID) throw new Error('TIKTOK_PROGRAMA_SHEET_ID not configured');
    const token = await getGoogleAccessToken();
    const tab = await getTabTitle(token);

    const existing = await findRowByEmail(data.email, tab, token);
    if (existing !== null) return { ok: true, duplicate: true };

    const now = new Date();
    const row = [
      data.nombre,
      data.idContacto || `bio-${data.source}`, // B id de contacto: id de ManyChat (DM) o canal de la bio
      fechaArtCompleta(now),
      data.email.toLowerCase().trim(),
      'SUCCESS',
      now.toISOString(),
      '', // G completo_form (cruce fase 2)
      '', // H fecha_completo_form
    ];

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`${tab}!A:H`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`TikTok sheet append failed (${res.status}): ${err}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('TikTok programa sheet log error (non-blocking):', err);
    return { ok: false };
  }
}
