/**
 * Alertas internas por mail (Brevo transaccional → APPROVAL_EMAIL).
 * Mismo patrón que enviarAviso del cron reconciliar-mp. Nunca lanza.
 */

const ALERT_SENDER = { email: 'info@urologia.ar', name: 'Nexo-mail · Embudo' };
const TIMEOUT_MS = 8000;

export async function enviarAlerta(subject: string, text: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  const to = process.env.APPROVAL_EMAIL;
  if (!apiKey || !to) {
    console.error('enviarAlerta: falta BREVO_API_KEY o APPROVAL_EMAIL', { subject });
    return false;
  }

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: ALERT_SENDER,
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) {
      console.error(`enviarAlerta: Brevo ${res.status}`, { subject });
      return false;
    }
    return true;
  } catch (err) {
    console.error('enviarAlerta: error', { subject, err });
    return false;
  }
}
