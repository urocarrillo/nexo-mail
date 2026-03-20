import crypto from 'crypto';

let cachedToken: { token: string; expiresAt: number } | null = null;

function getCredentials(): { email: string; privateKey: string } {
  // Option 1: Full JSON as base64 (preferred for Vercel — avoids newline issues)
  const jsonB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonB64) {
    const json = JSON.parse(Buffer.from(jsonB64, 'base64').toString('utf-8'));
    return { email: json.client_email, privateKey: json.private_key };
  }

  // Option 2: Individual env vars
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (email && privateKey) {
    return { email, privateKey };
  }

  throw new Error('Google service account credentials not configured');
}

export async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
    return cachedToken.token;
  }

  const { email, privateKey } = getCredentials();

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');

  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google auth failed: ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}
