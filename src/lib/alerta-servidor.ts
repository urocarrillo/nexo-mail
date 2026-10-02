/**
 * Alertas para solicitudes server-to-server (ManyChat → /api/form/*).
 *
 * ManyChat no avisa si su solicitud externa falla: le dice igual al lead
 * "ya te mandé el mail". Ya pasó dos veces (clave vacía → 403, body truncado
 * → 400). Si una solicitud SIN header Origin (o sea, no viene de un navegador)
 * termina en error, se manda una alerta por mail. Una por hora por
 * endpoint+motivo. Nunca lanza.
 */
import { kv } from '@vercel/kv';
import { enviarAlerta } from './alertas';

const THROTTLE_S = 60 * 60;

export function esServidorAServidor(origin: string | null): boolean {
  return !origin;
}

export async function alertarFallaServidor(
  endpoint: string,
  motivo: string,
  detalle: string
): Promise<void> {
  try {
    try {
      const got = await kv.set(`alerta-s2s:${endpoint}:${motivo}`, new Date().toISOString(), {
        nx: true,
        ex: THROTTLE_S,
      });
      if (!got) return;
    } catch {
      /* sin KV: avisar igual */
    }
    await enviarAlerta(
      `EMBUDO: falló una solicitud de ManyChat a ${endpoint} (${motivo})`,
      `Una solicitud server-to-server (sin Origin, típicamente ManyChat) a ${endpoint} terminó en "${motivo}".\n` +
        `${detalle}\n\n` +
        `El lead probablemente vio "ya te mandé el mail" y no le llegó nada.\n` +
        `Revisar en ManyChat la solicitud externa de esa automatización (header x-api-key con valor, body JSON completo).\n` +
        `Próxima alerta igual en 1 hora como mínimo.`
    );
  } catch (err) {
    console.error('alertarFallaServidor error:', err);
  }
}
