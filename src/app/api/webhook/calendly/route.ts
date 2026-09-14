import { NextRequest, NextResponse } from 'next/server';
import { deleteUnusedPatientCoupons } from '@/lib/woocommerce-coupons';
import {
  cancelarMailProgramado,
  debeProcesarse,
  desencolarReserva,
  encolarReserva,
  procesarReserva,
  type ReservaPendiente,
} from '@/lib/postconsulta';
import { enviarAlerta } from '@/lib/alertas';

/**
 * Webhook de Calendly (invitee.created / invitee.canceled) del embudo
 * post-consulta. Solo turnos "Atención Prioritaria".
 *
 * created  → encola la reserva en KV; el cron /api/cron/postconsulta crea el
 *            cupón y programa el mail EL DÍA DEL TURNO (Brevo no permite
 *            programar a más de 3 días). Si el turno es hoy, se procesa acá
 *            mismo para no depender del próximo tick del cron.
 * canceled → saca la reserva de la cola, borra el cupón sin usar de ese turno y
 *            revoca el mail programado en Brevo (por el messageId del cupón).
 *
 * Lógica de cupón/mail: src/lib/postconsulta.ts.
 */

export const maxDuration = 30;

// ─── Calendly webhook types ────────────────────────────────────────

interface CalendlyEvent {
  uri: string;
  name: string;
  start_time: string;
  end_time: string;
}

interface CalendlyWebhookPayload {
  event: string; // "invitee.created" | "invitee.canceled"
  payload: {
    event: string; // event URI
    name: string;
    email: string;
    scheduled_event?: CalendlyEvent;
    event_type?: {
      name: string;
    };
  };
}

const ALLOWED_EVENT_NAMES = ['Atención Prioritaria'];

function isAllowedEvent(payload: CalendlyWebhookPayload): boolean {
  const eventName = payload.payload.event_type?.name
    || payload.payload.scheduled_event?.name
    || '';
  return ALLOWED_EVENT_NAMES.some(
    allowed => eventName.toLowerCase().includes(allowed.toLowerCase())
  );
}

// ─── Route handlers ─────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    success: true,
    message: 'Calendly webhook endpoint is active. Use POST to receive events.',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: CalendlyWebhookPayload;

  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON' },
      { status: 400 }
    );
  }

  // Sin firma: endpoint abierto, riesgo bajo (a lo sumo un cupón 30 % de un solo uso)

  // Cancellation: drop the queued booking, revoke the scheduled email and the unused coupon
  if (body.event === 'invitee.canceled') {
    if (!isAllowedEvent(body)) {
      return NextResponse.json({ success: true, message: 'Ignored cancellation (event type)', skipped: true });
    }
    const { email } = body.payload;
    const eventUri = body.payload.event;
    if (!email) {
      return NextResponse.json({ success: false, error: 'Missing email' }, { status: 400 });
    }

    let dequeued = true;
    if (eventUri) {
      try {
        await desencolarReserva(eventUri);
      } catch (err) {
        dequeued = false;
        console.error('Calendly cancel: no se pudo sacar de la cola', eventUri, err);
      }
    }

    const couponCleanup = await deleteUnusedPatientCoupons({
      patientEmail: email,
      eventUri,
    });

    let emailCanceled = false;
    for (const messageId of couponCleanup.messageIds) {
      if (await cancelarMailProgramado(messageId)) emailCanceled = true;
    }

    console.log(
      `Cancellation processed: ${email} | dequeued: ${dequeued} | email revoked: ${emailCanceled} | coupons deleted: ${couponCleanup.deleted.join(', ') || 'none'}`
    );
    return NextResponse.json({
      success: true,
      message: 'Cancellation processed',
      dequeued,
      emailCanceled,
      couponsDeleted: couponCleanup.deleted,
    });
  }

  // Only process invitee.created events
  if (body.event !== 'invitee.created') {
    return NextResponse.json({
      success: true,
      message: `Ignored event: ${body.event}`,
      skipped: true,
    });
  }

  // Only process "Atención Prioritaria" events
  if (!isAllowedEvent(body)) {
    const eventName = body.payload.event_type?.name
      || body.payload.scheduled_event?.name
      || 'unknown';
    console.log(`Skipping non-eligible event type: ${eventName}`);
    return NextResponse.json({
      success: true,
      message: `Skipped event type: ${eventName}`,
      skipped: true,
    });
  }

  const { email, name } = body.payload;
  const eventUri = body.payload.event || body.payload.scheduled_event?.uri;
  const eventEndTime = body.payload.scheduled_event?.end_time;

  if (!email || !eventEndTime || !eventUri) {
    return NextResponse.json(
      { success: false, error: 'Missing email, event URI or event end time' },
      { status: 400 }
    );
  }
  const endTime = new Date(eventEndTime);
  if (Number.isNaN(endTime.getTime())) {
    return NextResponse.json({ success: false, error: 'Invalid event end time' }, { status: 400 });
  }

  const now = new Date();
  const reserva: ReservaPendiente = {
    eventUri,
    email,
    name: name || 'Paciente',
    endTime: endTime.toISOString(),
    createdAt: now.toISOString(),
    attempts: 0,
  };

  try {
    await encolarReserva(reserva);
  } catch (err) {
    // Sin KV no hay cola: si el turno cae dentro de lo que Brevo acepta,
    // procesamos ahora igual (comportamiento anterior); si no, avisamos.
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('Calendly webhook: no se pudo encolar la reserva:', msg);
    const horas = (endTime.getTime() - now.getTime()) / 3_600_000;
    if (horas > 60) {
      await enviarAlerta(
        `POST-CONSULTA: reserva sin encolar (KV caído) — ${email}`,
        `No se pudo guardar la reserva en KV y el turno está a ${horas.toFixed(0)} h (Brevo no acepta programar tan lejos).\n\nPaciente: ${name || 'Paciente'} <${email}>\nFin del turno: ${endTime.toISOString()}\nTurno: ${eventUri}\nError: ${msg}\n\nCuando llegue el día, mandar el mail a mano o volver a disparar el webhook.\n\n— Nexo-mail`
      );
      return NextResponse.json(
        { success: false, error: `Queue failed: ${msg}`, alerted: true },
        { status: 500 }
      );
    }
    const resultado = await procesarReserva(reserva, { now });
    return NextResponse.json({
      success: resultado.estado !== 'error',
      message: 'Queue failed; processed immediately',
      ...resultado,
    });
  }

  // Turno de hoy (o ya pasado): no esperamos al cron
  if (debeProcesarse(endTime, now)) {
    const resultado = await procesarReserva(reserva, { now });
    console.log(
      `Post-consultation (same day): ${email} | ${resultado.estado} | coupon: ${resultado.couponCode || '-'} | sendAt: ${resultado.sendAt || '-'}`
    );
    return NextResponse.json({
      success: resultado.estado !== 'error',
      message: resultado.estado === 'error' ? 'Queued; immediate processing failed (cron will retry)' : 'Coupon created and email scheduled via Brevo',
      queued: true,
      ...resultado,
    });
  }

  console.log(
    `Post-consultation booking queued: ${email} | send at: ${reserva.endTime} | event: ${eventUri}`
  );
  return NextResponse.json({
    success: true,
    message: 'Booking queued; coupon and email will be created on the day of the appointment',
    queued: true,
    sendAt: reserva.endTime,
  });
}
