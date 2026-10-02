import { NextRequest, NextResponse } from 'next/server';
import {
  TAGS_PUENTE,
  buscarPorEmail,
  crearEtiquetasFaltantes,
  etiquetarCliente,
  etiquetarTier,
  leerContactoManyChat,
  limpiarEtiquetas,
  listarEtiquetas,
  manychatHabilitado,
  obtenerContacto,
  type TierPuente,
} from '@/lib/manychat';

/**
 * Diagnóstico y prueba del puente Nexo-mail → ManyChat (sin DM real).
 * Protegido con API_SECRET_KEY (query ?token= o header x-api-key).
 *
 *   GET /api/admin/manychat-check?token=XXX                         → token ok + etiquetas de la cuenta
 *   GET /api/admin/manychat-check?token=XXX&crear_etiquetas=1       → crea TIER A/B/C y CLIENTE si faltan
 *   GET /api/admin/manychat-check?token=XXX&email=a@b.com           → id en KV + contacto en ManyChat + sus etiquetas
 *   GET /api/admin/manychat-check?token=XXX&email=a@b.com&tag=TIER%20A   → aplica la etiqueta (TIER A|B|C o CLIENTE)
 *   GET /api/admin/manychat-check?token=XXX&limpiar_etiquetas=1             → lista las etiquetas que borraría (dry run)
 *   GET /api/admin/manychat-check?token=XXX&limpiar_etiquetas=1&confirm=borrar → las borra de la cuenta (irreversible)
 */
export const maxDuration = 60;

function autorizado(request: NextRequest): boolean {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || request.headers.get('x-api-key');
  return Boolean(process.env.API_SECRET_KEY) && token === process.env.API_SECRET_KEY;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!autorizado(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const habilitado = manychatHabilitado();
  const out: Record<string, unknown> = { habilitado };
  if (!habilitado) {
    out.error = 'MANYCHAT_API_TOKEN no configurado';
    return NextResponse.json(out, { status: 503 });
  }

  const etiquetas = await listarEtiquetas();
  out.tokenOk = Array.isArray(etiquetas);
  out.etiquetasCuenta = etiquetas ? etiquetas.map((t) => t.name) : null;
  if (!etiquetas) {
    out.error = 'la API no respondió a getTags (token inválido o sin permisos)';
    return NextResponse.json(out, { status: 502 });
  }

  if (sp.get('crear_etiquetas') === '1') out.crearEtiquetas = await crearEtiquetasFaltantes();
  if (sp.get('limpiar_etiquetas') === '1') {
    out.limpiarEtiquetas = await limpiarEtiquetas(sp.get('confirm') === 'borrar');
  }

  const email = (sp.get('email') || '').trim().toLowerCase();
  if (email) {
    const kvContacto = await leerContactoManyChat(email);
    out.kv = kvContacto;
    const porEmail = await buscarPorEmail(email);
    const contacto = kvContacto ? await obtenerContacto(kvContacto.id) : porEmail;
    out.contacto = contacto
      ? {
          id: String(contacto.id),
          via: kvContacto ? 'kv' : porEmail ? 'email' : null,
          name: contacto.name ?? null,
          email: contacto.email ?? null,
          ig_username: contacto.ig_username ?? null,
          last_interaction: contacto.last_interaction ?? null,
          tags: (contacto.tags || []).map((t) => t.name),
        }
      : null;
    out.coincideKvYEmail = kvContacto && porEmail ? String(porEmail.id) === kvContacto.id : null;

    const tag = (sp.get('tag') || '').trim().toUpperCase();
    if (tag) {
      if (!TAGS_PUENTE.includes(tag)) {
        out.aplicar = { error: `tag inválida; permitidas: ${TAGS_PUENTE.join(', ')}` };
      } else if (tag === 'CLIENTE') {
        out.aplicar = { tag, ...(await etiquetarCliente(email)) };
      } else {
        out.aplicar = { tag, ...(await etiquetarTier(email, tag.slice(-1) as TierPuente)) };
      }
    }
  }

  return NextResponse.json(out);
}
