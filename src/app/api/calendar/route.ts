import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Endpoint consumido por el Reloj Friki (ESP32-C3) para mostrar eventos del día.
// Auth: ?key=RELOJ_API_KEY (query param simple, igual al firmware).
// Auth con Google: Service Account JWT → access token → Calendar API v3.

interface SACredentials {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface GoogleCalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
}

interface FirmwareEvent {
  title: string;
  start: string;
  end: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(creds: SACredentials, scopes: string[]): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: creds.client_email,
    scope: scopes.join(' '),
    aud: creds.token_uri,
    exp: now + 3600,
    iat: now,
  };
  const encodedHeader = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const encodedClaims = base64UrlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = base64UrlEncode(signer.sign(creds.private_key));
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Google token endpoint ${resp.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

function loadCredentials(): SACredentials | null {
  const b64 = process.env.GOOGLE_SA_JSON_B64;
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(json) as SACredentials;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key || key !== process.env.RELOJ_API_KEY) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const creds = loadCredentials();
  const calendarIdsRaw = process.env.GOOGLE_CALENDAR_IDS || '';
  const calendarIds = calendarIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!creds || calendarIds.length === 0) {
    return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(creds, ['https://www.googleapis.com/auth/calendar.readonly']);
  } catch (err) {
    return NextResponse.json({ error: 'auth_failed', detail: String(err) }, { status: 502 });
  }

  // Ventana: desde ahora hasta 24h adelante. Cubre el resto del día actual y parte del siguiente.
  const nowDate = new Date();
  const timeMin = nowDate.toISOString();
  const timeMax = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const allEvents: FirmwareEvent[] = [];

  for (const calId of calendarIds) {
    const apiUrl =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?` +
      `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
      `&singleEvents=true&orderBy=startTime&showDeleted=false&maxResults=20`;

    const resp = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    const items: GoogleCalendarEvent[] = data.items || [];

    for (const ev of items) {
      if (ev.status === 'cancelled') continue;
      const title = ev.summary || 'Sin título';
      if (/^(Canceled|Cancelado):/i.test(title)) continue;
      // Eventos "todo el día" usan `date`, eventos con horario usan `dateTime`. Filtramos los todo-el-día.
      if (!ev.start?.dateTime || !ev.end?.dateTime) continue;
      allEvents.push({
        title: title.length > 49 ? title.slice(0, 49) : title,
        start: ev.start.dateTime,
        end: ev.end.dateTime,
      });
    }
  }

  allEvents.sort((a, b) => a.start.localeCompare(b.start));
  const limited = allEvents.slice(0, 10);

  return NextResponse.json(
    { events: limited, updated: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
