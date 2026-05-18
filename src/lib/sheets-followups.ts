/**
 * Lectura y escritura del Sheet de Sesiones 1-1 del programa para el sistema
 * de follow-ups semanales. NO modifica logSesion() de sheets-sesiones.ts —
 * solo agrega lectura + update de las columnas E-H.
 *
 * Estructura del Sheet:
 *   A: Nombre · B: mail · C: fecha compra · D: Hecho? (sesión 1-1)
 *   E: Fecha sesión · F: D+7 enviado · G: D+30 enviado · H: Notas internas
 */
import { getGoogleAccessToken } from './google-auth';

const SHEET_ID = process.env.SESIONES_SHEET_ID || '';
const TAB_NAME = 'Hoja 1';

export interface FollowupRow {
  rowIndex: number;            // 1-based row number in Sheet
  nombre: string;
  email: string;
  fechaCompra: string;
  hecho: string;               // col D — "Hecho?" (texto libre, ej. "Sí" o fecha)
  fechaSesion: string;         // col E — ISO YYYY-MM-DD o "" si no hecha
  d7Enviado: string;           // col F — fecha cuando Mauro envió el D+7 ("" si no)
  d30Enviado: string;          // col G — fecha cuando Mauro envió el D+30 ("" si no)
  notas: string;               // col H
}

export interface PendingFollowup {
  row: FollowupRow;
  tipo: 'd7' | 'd30';
  diasDesdeSesion: number;
  urgencia: 'on-time' | 'late' | 'cold';   // on-time: <=10d para D+7 o <=33d para D+30. late: hasta cold. cold: ya muy tarde.
}

async function sheetsRequest(path: string, init?: RequestInit): Promise<Response> {
  if (!SHEET_ID) throw new Error('SESIONES_SHEET_ID not configured');
  const token = await getGoogleAccessToken();
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

function parseSheetDate(raw: string): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // ISO date YYYY-MM-DD
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  // DD/MM/YYYY (locale Argentina default)
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return new Date(Date.UTC(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1])));

  // Fallback Date constructor
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export async function readAllRows(): Promise<FollowupRow[]> {
  const range = encodeURIComponent(`${TAB_NAME}!A2:H1000`);
  const res = await sheetsRequest(`/values/${range}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to read sheet (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  const rows = data.values || [];
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    nombre: r[0] || '',
    email: (r[1] || '').trim().toLowerCase(),
    fechaCompra: r[2] || '',
    hecho: r[3] || '',
    fechaSesion: r[4] || '',
    d7Enviado: r[5] || '',
    d30Enviado: r[6] || '',
    notas: r[7] || '',
  }));
}

/**
 * Find pending follow-ups for "today" (UTC).
 *
 * D+7 pending: sesión hace >=7 días, <30 días, F vacía
 * D+30 pending: sesión hace >=30 días, <60 días, G vacía
 */
export function findPending(rows: FollowupRow[], now: Date = new Date()): PendingFollowup[] {
  const pending: PendingFollowup[] = [];
  for (const row of rows) {
    if (!row.email) continue;
    const sesion = parseSheetDate(row.fechaSesion);
    if (!sesion) continue;
    const days = daysBetween(sesion, now);

    if (days >= 7 && !row.d7Enviado) {
      let urgencia: PendingFollowup['urgencia'] = 'on-time';
      if (days >= 30) urgencia = 'cold';
      else if (days >= 10) urgencia = 'late';
      pending.push({ row, tipo: 'd7', diasDesdeSesion: days, urgencia });
    }

    if (days >= 30 && !row.d30Enviado) {
      let urgencia: PendingFollowup['urgencia'] = 'on-time';
      if (days >= 60) urgencia = 'cold';
      else if (days >= 33) urgencia = 'late';
      pending.push({ row, tipo: 'd30', diasDesdeSesion: days, urgencia });
    }
  }
  return pending;
}

/** Update F or G cell for a row with today's date (ISO). */
export async function markFollowupSent(
  rowIndex: number,
  tipo: 'd7' | 'd30',
  fechaEnvio: Date = new Date()
): Promise<void> {
  const col = tipo === 'd7' ? 'F' : 'G';
  const cell = `${TAB_NAME}!${col}${rowIndex}`;
  const iso = fechaEnvio.toISOString().slice(0, 10);
  const range = encodeURIComponent(cell);
  const res = await sheetsRequest(
    `/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      body: JSON.stringify({ values: [[iso]] }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to mark ${tipo} for row ${rowIndex} (${res.status}): ${err}`);
  }
}

/** Find row by email — returns null if not found. */
export async function findRowByEmail(email: string): Promise<FollowupRow | null> {
  const rows = await readAllRows();
  const normalized = email.trim().toLowerCase();
  return rows.find((r) => r.email === normalized) || null;
}
