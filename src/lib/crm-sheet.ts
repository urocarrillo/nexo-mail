/**
 * Lectura/escritura del Sheet CRM del programa (PRD-filtro-cliente).
 *
 * Sheet: 1bGAISPvP3QApE99o2Rz1A_f-zAGs-W3X7UrODcjUWiM
 * Hoja principal: "Cohorte 2 — Calificación"
 *
 * La columna `Cliente` no existe todavía: se crea en la primera columna libre
 * después de AE (por defecto AF = índice 31, 0-based). El código la detecta
 * dinámicamente por si el layout cambió: si ya hay un header "Cliente" lo
 * reusa; si no, toma la primera columna con header vacío a partir de AF.
 *
 * Auth: mismo service account de Google que sheets-sesiones / sheets-followups.
 */
import { getGoogleAccessToken } from './google-auth';
import { normalizeEmail } from './clientes';

export const CRM_SHEET_ID =
  process.env.CRM_SHEET_ID || '1bGAISPvP3QApE99o2Rz1A_f-zAGs-W3X7UrODcjUWiM';
export const CRM_TAB = 'Cohorte 2 — Calificación';
export const RECON_TAB = 'Reconciliación';

// Índice 0-based de la columna AE (primera columna "usada" tope según el PRD).
// La columna Cliente va en la primera libre a partir de AF (índice 31).
const AF_INDEX = 31;

// ─── Helpers de columnas (A, B, ... Z, AA, AB, ...) ─────────────────

export function colLetter(index0based: number): string {
  let n = index0based;
  let letter = '';
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

// ─── Request helper ─────────────────────────────────────────────────

async function sheetsRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = await getGoogleAccessToken();
  return fetch(`https://sheets.googleapis.com/v4/spreadsheets/${CRM_SHEET_ID}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

async function getValues(range: string): Promise<string[][]> {
  const res = await sheetsRequest(`/values/${encodeURIComponent(range)}`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CRM sheet read failed (${res.status}) [${range}]: ${err}`);
  }
  const data = (await res.json()) as { values?: string[][] };
  return data.values || [];
}

// ─── Detección de columnas ──────────────────────────────────────────

export function findEmailColumn(headers: string[]): number {
  const idx = headers.findIndex((h) => /correo|e-?mail/i.test(h || ''));
  return idx;
}

export function findClienteColumn(headers: string[]): number {
  return headers.findIndex((h) => (h || '').trim().toLowerCase() === 'cliente');
}

export function findEstadoColumn(headers: string[]): number {
  // Preferir "Estado seguimiento"; si no, cualquier header con "estado".
  const seg = headers.findIndex((h) => /estado.*segu/i.test(h || ''));
  if (seg >= 0) return seg;
  return headers.findIndex((h) => /estado/i.test(h || ''));
}

export function findPantallaColumn(headers: string[]): number {
  return headers.findIndex((h) => /pantalla/i.test(h || ''));
}

export function findNombreColumn(headers: string[]): number {
  return headers.findIndex((h) => /te llam|nombre|name/i.test(h || ''));
}

/**
 * Columna de fecha del test. Prioridad: "Submitted At" (Typeform) > marca
 * temporal/timestamp > fecha/date genérico. Nunca "Fecha primer contacto"
 * (columna de gestión, casi vacía — elegirla clasifica mal la edad del lead).
 * Fallback col A (0).
 */
export function findFechaColumn(headers: string[]): number {
  const prioridad = [/submitted at/i, /marca temporal|timestamp/i, /fecha|date/i];
  for (const re of prioridad) {
    const idx = headers.findIndex(
      (h) => re.test(h || '') && !/contacto/i.test(h || '')
    );
    if (idx >= 0) return idx;
  }
  return 0;
}

/** Columna de la secuencia post-Typeform ("Secuencia"), o -1 si no existe. */
export function findSecuenciaColumn(headers: string[]): number {
  return headers.findIndex((h) => (h || '').trim().toLowerCase() === 'secuencia');
}

/** Primera columna con header vacío a partir de `from` (0-based). */
export function firstFreeColumnAfter(headers: string[], from: number = AF_INDEX): number {
  let i = from;
  while (i < headers.length && (headers[i] || '').trim() !== '') i++;
  return i;
}

// ─── Modelo de lectura ──────────────────────────────────────────────

export interface CrmRow {
  rowIndex: number; // 1-based
  email: string; // normalizado
  cliente: string; // valor actual de la columna Cliente ('' si no existe/está vacía)
  estado: string; // valor actual de "Estado seguimiento" ('' si no existe/está vacía)
  pantalla: string; // valor actual de "Pantalla" ('' si no existe)
  fecha: string; // valor crudo de la columna de fecha del test ('' si no existe)
  nombre: string; // valor de la columna Nombre ('' si no existe)
  secuencia: string; // valor actual de la columna Secuencia ('' si no existe/está vacía)
}

export interface CrmSnapshot {
  headers: string[];
  emailCol: number; // 0-based
  clienteCol: number; // 0-based — columna destino (existente o a crear)
  clienteColExists: boolean;
  estadoCol: number; // 0-based, -1 si no se encuentra
  pantallaCol: number; // 0-based, -1 si no se encuentra
  nombreCol: number; // 0-based, -1 si no se encuentra
  fechaCol: number; // 0-based (findFechaColumn tiene fallback a 0)
  secuenciaCol: number; // 0-based — columna destino de la secuencia (existente o a crear)
  secuenciaColExists: boolean;
  rows: CrmRow[];
}

export async function readCrmSheet(): Promise<CrmSnapshot> {
  const headerRows = await getValues(`${CRM_TAB}!1:1`);
  const headers = headerRows[0] || [];

  const emailCol = findEmailColumn(headers);
  if (emailCol < 0) {
    throw new Error(`No se encontró la columna de email en "${CRM_TAB}" (headers: ${headers.join(' | ')})`);
  }

  const existingCliente = findClienteColumn(headers);
  const clienteCol = existingCliente >= 0 ? existingCliente : firstFreeColumnAfter(headers, AF_INDEX);
  const estadoCol = findEstadoColumn(headers);
  const pantallaCol = findPantallaColumn(headers);
  const nombreCol = findNombreColumn(headers);
  const fechaCol = findFechaColumn(headers);

  // Columna Secuencia: reusa el header "Secuencia" si existe; si no, primera
  // libre después de AF sin colisionar con la columna Cliente recién asignada.
  const existingSec = findSecuenciaColumn(headers);
  let secuenciaCol: number;
  if (existingSec >= 0) {
    secuenciaCol = existingSec;
  } else {
    secuenciaCol = firstFreeColumnAfter(headers, AF_INDEX);
    if (existingCliente < 0 && secuenciaCol === clienteCol) {
      secuenciaCol = firstFreeColumnAfter(headers, clienteCol + 1);
    }
  }

  const lastCol = Math.max(
    headers.length - 1,
    clienteCol,
    emailCol,
    estadoCol,
    pantallaCol,
    nombreCol,
    fechaCol,
    secuenciaCol
  );
  const dataRange = `${CRM_TAB}!A2:${colLetter(lastCol)}`;
  const values = await getValues(dataRange);

  const rows: CrmRow[] = values.map((r, i) => ({
    rowIndex: i + 2,
    email: normalizeEmail(r[emailCol] || ''),
    cliente: existingCliente >= 0 ? r[existingCliente] || '' : '',
    estado: estadoCol >= 0 ? r[estadoCol] || '' : '',
    pantalla: pantallaCol >= 0 ? r[pantallaCol] || '' : '',
    fecha: r[fechaCol] || '',
    nombre: nombreCol >= 0 ? r[nombreCol] || '' : '',
    secuencia: existingSec >= 0 ? r[existingSec] || '' : '',
  }));

  return {
    headers,
    emailCol,
    clienteCol,
    clienteColExists: existingCliente >= 0,
    estadoCol,
    pantallaCol,
    nombreCol,
    fechaCol,
    secuenciaCol,
    secuenciaColExists: existingSec >= 0,
    rows,
  };
}

/** email → texto actual de la columna Cliente (para el diff del cron). */
export async function getSheetMarcas(): Promise<Map<string, string>> {
  const snap = await readCrmSheet();
  const marcas = new Map<string, string>();
  for (const row of snap.rows) {
    if (row.email) marcas.set(row.email, row.cliente);
  }
  return marcas;
}

// ─── Escritura ──────────────────────────────────────────────────────

interface CellUpdate {
  range: string; // A1 notation con tab
  value: string;
}

async function valuesBatchUpdate(updates: CellUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const body = {
    valueInputOption: 'USER_ENTERED',
    data: updates.map((u) => ({ range: u.range, values: [[u.value]] })),
  };
  const res = await sheetsRequest(`/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CRM sheet batchUpdate failed (${res.status}): ${err}`);
  }
}

/**
 * Escribe la columna Cliente para las filas indicadas + (si hace falta) el
 * header de la columna. `updates` = filas a marcar con su texto.
 */
export async function writeClienteColumn(
  snap: CrmSnapshot,
  updates: Array<{ rowIndex: number; text: string }>
): Promise<void> {
  const col = colLetter(snap.clienteCol);
  const cells: CellUpdate[] = [];

  if (!snap.clienteColExists) {
    cells.push({ range: `${CRM_TAB}!${col}1`, value: 'Cliente' });
  }
  for (const u of updates) {
    cells.push({ range: `${CRM_TAB}!${col}${u.rowIndex}`, value: u.text });
  }
  await valuesBatchUpdate(cells);
}

/**
 * Marca UN email en el Sheet CRM (usado por el webhook WC).
 * Escribe la columna Cliente + Estado seguimiento = "COMPRÓ".
 * Best-effort: si el email no está en el Sheet, no hace nada.
 */
export async function markClienteInCRM(
  email: string,
  clienteText: string,
  estadoText = 'COMPRÓ'
): Promise<{ found: boolean }> {
  const snap = await readCrmSheet();
  const target = normalizeEmail(email);
  const row = snap.rows.find((r) => r.email === target);
  if (!row) return { found: false };

  const cells: CellUpdate[] = [];
  const col = colLetter(snap.clienteCol);
  if (!snap.clienteColExists) {
    cells.push({ range: `${CRM_TAB}!${col}1`, value: 'Cliente' });
  }
  cells.push({ range: `${CRM_TAB}!${col}${row.rowIndex}`, value: clienteText });
  if (snap.estadoCol >= 0) {
    cells.push({
      range: `${CRM_TAB}!${colLetter(snap.estadoCol)}${row.rowIndex}`,
      value: estadoText,
    });
  }
  await valuesBatchUpdate(cells);
  return { found: true };
}

/**
 * Escribe la columna Secuencia para las filas indicadas (+ header si hace falta).
 * Usado por el motor drip tras cada envío de la secuencia post-Typeform.
 * `updates` = filas a marcar con su texto (ej: "sq3 enviado 08/07").
 */
export async function writeSecuenciaMarks(
  snap: CrmSnapshot,
  updates: Array<{ rowIndex: number; text: string }>
): Promise<void> {
  if (updates.length === 0 && snap.secuenciaColExists) return;
  const col = colLetter(snap.secuenciaCol);
  const cells: CellUpdate[] = [];
  if (!snap.secuenciaColExists) {
    cells.push({ range: `${CRM_TAB}!${col}1`, value: 'Secuencia' });
  }
  for (const u of updates) {
    cells.push({ range: `${CRM_TAB}!${col}${u.rowIndex}`, value: u.text });
  }
  await valuesBatchUpdate(cells);
}

/**
 * Marca la columna Secuencia para uno o varios emails, buscando la fila por email
 * (primera coincidencia). Lee el snapshot una vez. Emails ausentes del Sheet se
 * ignoran (best-effort). Usado por el webhook typeform (tier C) y el backfill.
 */
export async function markSecuenciaForEmails(
  marks: Array<{ email: string; text: string }>
): Promise<{ marked: number; notFound: string[] }> {
  if (marks.length === 0) return { marked: 0, notFound: [] };
  const snap = await readCrmSheet();

  const rowByEmail = new Map<string, number>();
  for (const row of snap.rows) {
    if (row.email && !rowByEmail.has(row.email)) rowByEmail.set(row.email, row.rowIndex);
  }

  const updates: Array<{ rowIndex: number; text: string }> = [];
  const notFound: string[] = [];
  for (const m of marks) {
    const email = normalizeEmail(m.email);
    const rowIndex = rowByEmail.get(email);
    if (rowIndex) updates.push({ rowIndex, text: m.text });
    else notFound.push(email);
  }

  if (updates.length === 0) return { marked: 0, notFound };
  await writeSecuenciaMarks(snap, updates);
  return { marked: updates.length, notFound };
}

// ─── Tab de Reconciliación ──────────────────────────────────────────

async function tabExists(title: string): Promise<boolean> {
  const res = await sheetsRequest(`?fields=sheets.properties.title`);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CRM sheet metadata failed (${res.status}): ${err}`);
  }
  const data = (await res.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
  return (data.sheets || []).some((s) => s.properties?.title === title);
}

export async function ensureTab(title: string): Promise<void> {
  if (await tabExists(title)) return;
  const res = await sheetsRequest(`:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CRM sheet addSheet "${title}" failed (${res.status}): ${err}`);
  }
}

/** Agrega filas al tab de Reconciliación (lo crea si no existe). */
export async function appendReconciliacion(rows: string[][]): Promise<void> {
  if (rows.length === 0) return;
  await ensureTab(RECON_TAB);
  const range = encodeURIComponent(`${RECON_TAB}!A:E`);
  const res = await sheetsRequest(
    `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: rows }) }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Reconciliación append failed (${res.status}): ${err}`);
  }
}
