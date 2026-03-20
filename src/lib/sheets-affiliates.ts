import { getGoogleAccessToken } from './google-auth';

const SHEET_ID = process.env.AFFILIATES_SHEET_ID || '';
const BASE_URL = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

async function sheetsRequest(path: string, options: RequestInit = {}) {
  const token = await getGoogleAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API error (${res.status}): ${err}`);
  }
  return res.json();
}

export interface Affiliate {
  codigo: string;
  nombre: string;
  email: string;
  whatsapp: string;
  alias: string;
  cbu: string;
  comision_pct: number;
  destino: string;
  fecha_alta: string;
  estado: string;
}

export interface Sale {
  fecha: string;
  pedido: string;
  monto: string;
  codigo: string;
  nombre: string;
  comision: string;
  pagado: string;
}

export async function getAffiliates(): Promise<Affiliate[]> {
  const data = await sheetsRequest('/values/Afiliados!A2:J1000');
  const rows: string[][] = data.values || [];
  return rows.map((r) => ({
    codigo: r[0] || '',
    nombre: r[1] || '',
    email: r[2] || '',
    whatsapp: r[3] || '',
    alias: r[4] || '',
    cbu: r[5] || '',
    comision_pct: parseFloat(r[6]) || 0,
    destino: r[7] || 'recuperatuereccion',
    fecha_alta: r[8] || '',
    estado: r[9] || 'Activo',
  }));
}

export async function getAffiliate(code: string): Promise<Affiliate | null> {
  const affiliates = await getAffiliates();
  return affiliates.find((a) => a.codigo === code) || null;
}

export async function addAffiliate(data: Omit<Affiliate, 'fecha_alta' | 'estado'>): Promise<Affiliate> {
  const fecha = new Date().toLocaleDateString('es-AR');
  const row = [
    data.codigo,
    data.nombre,
    data.email,
    data.whatsapp,
    data.alias,
    data.cbu,
    data.comision_pct.toString(),
    data.destino,
    fecha,
    'Activo',
  ];

  await sheetsRequest('/values/Afiliados!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });

  return { ...data, fecha_alta: fecha, estado: 'Activo' };
}

export async function logSale(data: {
  pedido: string;
  monto: number;
  codigo: string;
  nombre: string;
  comision: number;
}): Promise<void> {
  const fecha = new Date().toLocaleDateString('es-AR');
  const row = [
    fecha,
    data.pedido,
    data.monto.toFixed(2),
    data.codigo,
    data.nombre,
    data.comision.toFixed(2),
    '☐',
  ];

  await sheetsRequest('/values/Ventas!A:G:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });
}

export async function getSales(): Promise<Sale[]> {
  const data = await sheetsRequest('/values/Ventas!A2:G1000');
  const rows: string[][] = data.values || [];
  return rows.map((r) => ({
    fecha: r[0] || '',
    pedido: r[1] || '',
    monto: r[2] || '0',
    codigo: r[3] || '',
    nombre: r[4] || '',
    comision: r[5] || '0',
    pagado: r[6] || '☐',
  }));
}

export function generateCode(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const l1 = letters[Math.floor(Math.random() * 26)];
  const l2 = letters[Math.floor(Math.random() * 26)];
  const n1 = Math.floor(Math.random() * 10);
  const n2 = Math.floor(Math.random() * 10);
  return `${l1}${l2}${n1}${n2}`;
}

export function getAffiliateLink(affiliate: Affiliate): string {
  if (affiliate.destino === 'control-eyaculacion-precoz') {
    return `https://urologia.ar/cursos/control-eyaculacion-precoz/?ref=${affiliate.codigo}`;
  }
  return `https://urologia.ar/go/${affiliate.codigo}`;
}
