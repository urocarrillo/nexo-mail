import { NextRequest, NextResponse } from 'next/server';
import { kv } from '@vercel/kv';
import {
  debeProcesarse,
  listarPendientes,
  procesarCuponesHuerfanos,
  procesarReserva,
  type ResultadoProceso,
} from '@/lib/postconsulta';
import { enviarAlerta } from '@/lib/alertas';

/**
 * Cron del embudo post-consulta Calendly (cupón PAC + mail al fin del turno).
 *
 * Se dispara encadenado desde /api/cron/reconciliar-mp (Hostinger, cada 10 min)
 * y una vez por día desde vercel.json (03:30 UTC = 00:30 Argentina) como
 * respaldo: esa corrida deja armados cupón y mail de todos los turnos del día.
 *
 * Por corrida:
 *  1. Reservas en cola (KV `postconsulta:pending`) cuyo turno es HOY (hora
 *     Argentina) o ya pasó → crea el cupón (vence 24 h después del envío),
 *     programa el mail en Brevo para el fin del turno y saca la reserva de la
 *     cola. Si falla, queda en cola con attempts+1 y se reintenta.
 *  2. Red de seguridad: cupones PAC sin `_brevo_message_id` cuyo día de envío
 *     llegó → se les programa el mail.
 *  3. Alerta por mail (APPROVAL_EMAIL) si algo falló, con throttle por turno.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> o ?token=<CRON_SECRET>.
 * Params: ?dry=1 (no crea, no envía, no toca la cola).
 */

export const maxDuration = 60;

const LOCK_KEY = 'lock:postconsulta';
const LOCK_TTL_S = 55;
const DEADLINE_MS = 45_000;
const ALERT_THROTTLE_S = 6 * 60 * 60;
const MAX_ALERT_ATTEMPTS = 24; // ~4 h de reintentos cada 10 min antes de avisar por segunda vez

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function alertarFallo(r: ResultadoProceso, attempts: number): Promise<void> {
  const key = `alerta:postconsulta:${r.eventUri}`;
  try {
    const got = await kv.set(key, new Date().toISOString(), { nx: true, ex: ALERT_THROTTLE_S });
    if (!got && attempts < MAX_ALERT_ATTEMPTS) return;
  } catch {
    /* sin KV igual avisamos */
  }
  await enviarAlerta(
    `POST-CONSULTA: falló el cupón/mail de ${r.email}`,
    `No se pudo dejar programado el mail post-consulta.\n\nPaciente: ${r.email}\nTurno: ${r.eventUri}\nCupón: ${r.couponCode || 'no creado'}\nIntentos: ${attempts}\nError: ${r.error || 'sin detalle'}\n\nEl cron reintenta cada 10 minutos. Si el turno ya pasó y el paciente sigue sin mail, mandarlo a mano (template Brevo #158, params NOMBRE y COUPON_CODE).\n\n— Nexo-mail`
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const token = url.searchParams.get('token');
  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && token !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dry = url.searchParams.get('dry') === '1';
  const now = new Date();
  const deadline = Date.now() + DEADLINE_MS;

  let lockTaken = false;
  if (!dry) {
    try {
      const got = await kv.set(LOCK_KEY, now.toISOString(), { nx: true, ex: LOCK_TTL_S });
      if (!got) return NextResponse.json({ skipped: 'lock', dry });
      lockTaken = true;
    } catch (err) {
      const msg = errMsg(err);
      await enviarAlerta('POST-CONSULTA: KV no disponible', `${msg}\n\nNo se procesó nada.`);
      return NextResponse.json({ error: `KV no disponible: ${msg}` }, { status: 500 });
    }
  }

  try {
    const pendientes = await listarPendientes();
    const debidas = pendientes.filter(r => debeProcesarse(new Date(r.endTime), now));

    const reservas: ResultadoProceso[] = [];
    for (const r of debidas) {
      if (Date.now() > deadline) break;
      const res = await procesarReserva(r, { now, dry });
      reservas.push(res);
      if (!dry && res.estado === 'error') await alertarFallo(res, r.attempts + 1);
    }

    let huerfanos: ResultadoProceso[] = [];
    let huerfanosError: string | undefined;
    if (Date.now() < deadline) {
      try {
        huerfanos = await procesarCuponesHuerfanos({ now, dry, deadline });
        for (const h of huerfanos) {
          if (!dry && h.estado === 'error') await alertarFallo(h, 1);
        }
      } catch (err) {
        huerfanosError = errMsg(err);
        console.error('Post-consulta: fallo la red de seguridad de cupones:', huerfanosError);
      }
    }

    const resumen = (rs: ResultadoProceso[]) =>
      rs.reduce<Record<string, number>>((acc, r) => {
        acc[r.estado] = (acc[r.estado] || 0) + 1;
        return acc;
      }, {});

    return NextResponse.json({
      dry,
      ahora: now.toISOString(),
      en_cola: pendientes.length,
      debidas: debidas.length,
      reservas: { resumen: resumen(reservas), detalle: reservas },
      huerfanos: { resumen: resumen(huerfanos), detalle: huerfanos, error: huerfanosError },
      proximas: pendientes
        .filter(r => !debeProcesarse(new Date(r.endTime), now))
        .map(r => ({ email: r.email, endTime: r.endTime, attempts: r.attempts })),
    });
  } catch (err) {
    const msg = errMsg(err);
    console.error('Post-consulta cron error:', msg);
    if (!dry) await enviarAlerta('POST-CONSULTA: error inesperado del cron', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (lockTaken) {
      try {
        await kv.del(LOCK_KEY);
      } catch (err) {
        console.error('Post-consulta: no se pudo soltar el lock:', err);
      }
    }
  }
}
