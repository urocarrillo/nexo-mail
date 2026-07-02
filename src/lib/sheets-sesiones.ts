import { getGoogleAccessToken } from './google-auth';

const SHEET_ID = process.env.SESIONES_SHEET_ID || '';
const TAB_NAME = 'Hoja 1';

export async function logSesion(data: {
  nombre: string;
  email: string;
  fechaCompra: string;
}): Promise<void> {
  if (!SHEET_ID) {
    throw new Error('SESIONES_SHEET_ID not configured');
  }

  const token = await getGoogleAccessToken();

  // Dedupe: una fila por paciente. Si el email ya está en la columna B, no
  // volver a agregarlo (order.updated puede reintentar la misma orden).
  const checkRange = encodeURIComponent(`${TAB_NAME}!B:B`);
  const checkRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${checkRange}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (checkRes.ok) {
    const existing: string[] = ((await checkRes.json()).values ?? []).flat();
    const target = data.email.toLowerCase().trim();
    if (existing.some((e) => (e || '').toLowerCase().trim() === target)) {
      return;
    }
  }

  const range = encodeURIComponent(`${TAB_NAME}!A:D`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const row = [data.nombre, data.email, data.fechaCompra, ''];

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sesiones sheet append failed (${res.status}): ${err}`);
  }
}
