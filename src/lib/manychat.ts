/**
 * Puente Nexo-mail → ManyChat (fase 2 del embudo del programa).
 *
 * ManyChat capta el mail por DM (Instagram / TikTok) y manda a
 * /api/form/programa el {Id de contacto} como `manychat_id`. Acá se guarda en
 * KV (`mc:<email>`) y, cuando el lead termina el test o compra, se le pone la
 * etiqueta en ManyChat (TIER A/B/C, CLIENTE) para filtrar en el Inbox.
 *
 * Reglas:
 *  - Solo etiqueta. Nunca manda mensajes (ventanas IG 24 h / TikTok 48 h).
 *  - Best-effort: ninguna función lanza; sin MANYCHAT_API_TOKEN no hace nada.
 *  - Sin id en KV (lead anterior al puente) busca el contacto por email.
 *
 * API verificada 01/10/2026 contra el spec oficial
 * (api.manychat.com/swagger/compileJson?type=Page_API): Bearer token,
 * POST /fb/subscriber/addTagByName {subscriber_id, tag_name}, removeTagByName,
 * GET /fb/subscriber/findBySystemField?email=, GET /fb/page/getTags,
 * POST /fb/page/createTag {name}. Límite 10 req/s en etiquetas.
 */
import { kv } from '@vercel/kv';
import { enviarAlerta } from './alertas';

const API_BASE = 'https://api.manychat.com';
const TIMEOUT_MS = 5_000;
const KV_PREFIX = 'mc:';
const KV_TTL_S = 60 * 60 * 24 * 180; // 180 días
const ALERTA_AUTH_KEY = 'mc:alerta:auth';
const ALERTA_AUTH_TTL_S = 60 * 60 * 24;
const LOG = 'ManyChat:';

export type TierPuente = 'A' | 'B' | 'C';
export const TAGS_TIER: Record<TierPuente, string> = { A: 'TIER A', B: 'TIER B', C: 'TIER C' };
export const TAG_CLIENTE = 'CLIENTE';
export const TAGS_PUENTE: readonly string[] = [TAGS_TIER.A, TAGS_TIER.B, TAGS_TIER.C, TAG_CLIENTE];

export interface ContactoManyChat {
  id: string;
  source: string;
  ts: string;
}

export interface ResultadoPuente {
  ok: boolean;
  id?: string;
  via?: 'kv' | 'email';
  /** 'sin-token' | 'sin-contacto' | texto del error */
  motivo?: string;
}

export interface EtiquetaManyChat {
  id: number;
  name: string;
}

export interface SubscriberManyChat {
  id: number | string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  ig_username?: string | null;
  last_interaction?: string | null;
  tags?: EtiquetaManyChat[];
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function manychatHabilitado(): boolean {
  return Boolean(process.env.MANYCHAT_API_TOKEN);
}

/** {Id de contacto} tal como llega del body: entero positivo de hasta 20 dígitos. */
export function parseManychatId(v: unknown): string | null {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? String(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[1-9]\d{0,19}$/.test(s) ? s : null;
}

/**
 * Fuente efectiva del lead: con id de ManyChat el canal pasa a "-dm" (llegó
 * por DM, no por la bio). Otras fuentes quedan igual.
 */
export function sourceConDm(source: string, manychatId: string | null): string {
  if (!manychatId) return source;
  if (source === 'instagram' || source === 'tiktok') return `${source}-dm`;
  return source;
}

function emailKey(email: string): string {
  return `${KV_PREFIX}${email.trim().toLowerCase()}`;
}

export async function guardarContactoManyChat(email: string, id: string, source: string): Promise<boolean> {
  const value: ContactoManyChat = { id, source, ts: new Date().toISOString() };
  try {
    await kv.set(emailKey(email), value, { ex: KV_TTL_S });
    return true;
  } catch (err) {
    console.error(LOG, 'kv.set error (sigue):', errMsg(err));
    return false;
  }
}

export async function leerContactoManyChat(email: string): Promise<ContactoManyChat | null> {
  try {
    const v = await kv.get<ContactoManyChat | string>(emailKey(email));
    if (!v) return null;
    const obj = typeof v === 'string' ? (JSON.parse(v) as ContactoManyChat) : v;
    return obj && typeof obj.id === 'string' && obj.id ? obj : null;
  } catch (err) {
    console.error(LOG, 'kv.get error (sigue):', errMsg(err));
    return null;
  }
}

async function avisarAuth(status: number, detalle: string): Promise<void> {
  try {
    const got = await kv.set(ALERTA_AUTH_KEY, new Date().toISOString(), { nx: true, ex: ALERTA_AUTH_TTL_S });
    if (!got) return;
  } catch {
    /* sin KV: avisar igual */
  }
  await enviarAlerta(
    `MANYCHAT: la API rechazó el token (${status})`,
    `El puente Nexo-mail → ManyChat no pudo autenticarse (HTTP ${status}).\n${detalle}\n\n` +
      `Las etiquetas TIER/CLIENTE no se están aplicando. Regenerar el token en ManyChat ` +
      `(Configuración → API) y actualizar MANYCHAT_API_TOKEN en Vercel.`
  ).catch(() => undefined);
}

async function llamar<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {}
): Promise<ApiResult<T>> {
  const token = process.env.MANYCHAT_API_TOKEN;
  if (!token) return { ok: false, status: 0, error: 'sin-token' };

  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, v);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const raw = await res.text();
    type Respuesta = { status?: string; data?: T; message?: string };
    let json: Respuesta | null = null;
    try {
      json = raw ? (JSON.parse(raw) as Respuesta) : null;
    } catch {
      json = null;
    }
    if (res.ok && json && json.status === 'success') return { ok: true, data: json.data as T };
    const error = `${res.status}: ${json?.message || raw.slice(0, 300) || res.statusText}`;
    if (res.status === 401 || res.status === 403) await avisarAuth(res.status, error);
    return { ok: false, status: res.status, error };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? `timeout ${TIMEOUT_MS} ms` : errMsg(err);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function buscarPorEmail(email: string): Promise<SubscriberManyChat | null> {
  const r = await llamar<SubscriberManyChat | null>('GET', '/fb/subscriber/findBySystemField', {
    query: { email: email.trim().toLowerCase() },
  });
  if (!r.ok) {
    if (r.error !== 'sin-token') console.log(LOG, 'findBySystemField sin resultado:', r.error);
    return null;
  }
  return r.data && r.data.id ? r.data : null;
}

export async function obtenerContacto(id: string): Promise<SubscriberManyChat | null> {
  const r = await llamar<SubscriberManyChat | null>('GET', '/fb/subscriber/getInfo', { query: { subscriber_id: id } });
  return r.ok && r.data && r.data.id ? r.data : null;
}

/** Id de ManyChat del lead: primero KV (lo mandó ManyChat), si no por email. */
export async function resolverSubscriberId(email: string): Promise<{ id: string; via: 'kv' | 'email' } | null> {
  const guardado = await leerContactoManyChat(email);
  if (guardado) return { id: guardado.id, via: 'kv' };
  const sub = await buscarPorEmail(email);
  if (sub) return { id: String(sub.id), via: 'email' };
  return null;
}

export async function agregarEtiqueta(subscriberId: string, tagName: string): Promise<ApiResult<unknown>> {
  return llamar('POST', '/fb/subscriber/addTagByName', {
    body: { subscriber_id: Number(subscriberId), tag_name: tagName },
  });
}

export async function quitarEtiqueta(subscriberId: string, tagName: string): Promise<ApiResult<unknown>> {
  return llamar('POST', '/fb/subscriber/removeTagByName', {
    body: { subscriber_id: Number(subscriberId), tag_name: tagName },
  });
}

export async function listarEtiquetas(): Promise<EtiquetaManyChat[] | null> {
  const r = await llamar<EtiquetaManyChat[]>('GET', '/fb/page/getTags');
  return r.ok && Array.isArray(r.data) ? r.data : null;
}

/** Crea en ManyChat las etiquetas del puente que falten (TIER A/B/C, CLIENTE). */
export async function crearEtiquetasFaltantes(): Promise<{ creadas: string[]; existentes: string[]; error?: string }> {
  const actuales = await listarEtiquetas();
  if (!actuales) return { creadas: [], existentes: [], error: 'no se pudo listar etiquetas (token?)' };
  const nombres = new Set(actuales.map((t) => t.name.trim().toLowerCase()));
  const creadas: string[] = [];
  const existentes: string[] = [];
  let error: string | undefined;
  for (const tag of TAGS_PUENTE) {
    if (nombres.has(tag.toLowerCase())) {
      existentes.push(tag);
      continue;
    }
    const r = await llamar('POST', '/fb/page/createTag', { body: { name: tag } });
    if (r.ok) creadas.push(tag);
    else error = `${error ? `${error}; ` : ''}${tag}: ${r.error}`;
  }
  return { creadas, existentes, ...(error ? { error } : {}) };
}

async function etiquetar(email: string, poner: string, sacar: string[]): Promise<ResultadoPuente> {
  if (!manychatHabilitado()) return { ok: false, motivo: 'sin-token' };
  try {
    const sub = await resolverSubscriberId(email);
    if (!sub) return { ok: false, motivo: 'sin-contacto' };
    const r = await agregarEtiqueta(sub.id, poner);
    if (!r.ok) return { ok: false, id: sub.id, via: sub.via, motivo: r.error };
    // Las contrarias se sacan sin mirar (si no la tenía, ManyChat responde error y se ignora).
    for (const tag of sacar) await quitarEtiqueta(sub.id, tag);
    return { ok: true, id: sub.id, via: sub.via };
  } catch (err) {
    return { ok: false, motivo: errMsg(err) };
  }
}

/** Al terminar el test: TIER A/B/C (y saca las otras dos por si repitió el test). */
export async function etiquetarTier(email: string, tier: TierPuente): Promise<ResultadoPuente> {
  const poner = TAGS_TIER[tier];
  const sacar = Object.values(TAGS_TIER).filter((t) => t !== poner);
  const r = await etiquetar(email, poner, sacar);
  if (r.motivo !== 'sin-token') console.log(LOG, 'tier', { tier, ...r });
  return r;
}

/** Al comprar el programa (3740 o combo 5243): CLIENTE. */
export async function etiquetarCliente(email: string): Promise<ResultadoPuente> {
  const r = await etiquetar(email, TAG_CLIENTE, []);
  if (r.motivo !== 'sin-token') console.log(LOG, 'cliente', r);
  return r;
}

/** Etiquetas que usa el embudo (4 automatizaciones principales + Nexo-mail). Todo lo demás es borrable. */
export const ETIQUETAS_A_CONSERVAR: readonly string[] = [
  'LEAD PROGRAMA',
  'LEAD EP',
  'PROBLEMA MAIL',
  'PROGRAMA MAIL',
  ...TAGS_PUENTE,
];

function normalizarEtiqueta(n: string): string {
  // "📧PROBLEMA MAIL" → "PROBLEMA MAIL": se ignoran emojis y símbolos al comparar.
  return n.replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Borra de la cuenta (y de todos los contactos) las etiquetas que no están en
 * ETIQUETAS_A_CONSERVAR. Sin `ejecutar` solo lista lo que borraría.
 * POST /fb/page/removeTag {tag_id} — irreversible.
 */
export async function limpiarEtiquetas(ejecutar: boolean): Promise<{
  conservar: string[];
  borrar: string[];
  borradas: string[];
  errores: string[];
}> {
  const actuales = (await listarEtiquetas()) || [];
  const keep = new Set(ETIQUETAS_A_CONSERVAR.map(normalizarEtiqueta));
  const conservar = actuales.filter((t) => keep.has(normalizarEtiqueta(t.name)));
  const borrar = actuales.filter((t) => !keep.has(normalizarEtiqueta(t.name)));
  const borradas: string[] = [];
  const errores: string[] = [];
  if (ejecutar) {
    for (const t of borrar) {
      const r = await llamar('POST', '/fb/page/removeTag', { body: { tag_id: t.id } });
      if (r.ok) borradas.push(t.name);
      else errores.push(`${t.name}: ${r.error}`);
      await new Promise((res) => setTimeout(res, 150)); // < 10 req/s
    }
  }
  return { conservar: conservar.map((t) => t.name), borrar: borrar.map((t) => t.name), borradas, errores };
}
