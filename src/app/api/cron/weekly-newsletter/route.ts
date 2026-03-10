import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const BLOG_LIST_ID = 29;
const NEWSLETTER_TAG_ID = 125;

interface WPPost {
  id: number;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  link: string;
  slug: string;
  status: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

interface EmailCopy {
  preheader: string;
  hook: string;
  value: string;
  curiosity: string;
  subject: string;
}

async function generateEmailCopy(title: string, content: string): Promise<EmailCopy> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const plainContent = stripHtml(content).slice(0, 4000);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Sos el Urólogo Mauro Carrillo. Escribís en español rioplatense (vos, tenés). Generá el copy para un email de newsletter semanal sobre esta nota de blog.

TÍTULO: ${title}

CONTENIDO DE LA NOTA:
${plainContent}

Generá un JSON con esta estructura:
{
  "preheader": "Línea curiosa, NO repetir título. Max 100 chars. Sin palabras explícitas.",
  "hook": "2-3 líneas con pregunta o situación que conecte. Directo, empático, rioplatense. El lector se tiene que sentir identificado.",
  "value": "3-4 datos concretos del artículo que aporten valor real. Cada dato en su propio párrafo, separados por <br><br>. Números, porcentajes, datos técnicos reales del artículo. Directo, sin rodeos.",
  "curiosity": "1-2 líneas que mencionen OTROS temas que cubre la nota para generar curiosidad. Cerrar con 'Leé la nota completa 👇'. NUNCA inventar datos.",
  "subject": "Subject con pregunta o intriga. Max 60 chars. Sin palabras explícitas."
}

EJEMPLO DE EMAIL APROBADO:
Hook: "¿Sabés realmente qué hace la testosterona en tu cuerpo? Es una hormona que controla casi todo — y probablemente no sabés cómo funciona."
Value: "Los niveles normales oscilan entre 300 y 1000 nanogramos por decilitro. Por debajo de 300 ya estás en zona roja.<br><br>Tu cuerpo tiene un sistema inteligente (el eje HPG) que regula la producción como un termostato. Cuando le sumás testosterona de afuera, ese sistema se apaga.<br><br>Afecta tu densidad ósea, metabolismo, salud cardiovascular, humor y concentración. No es solo deseo."
Curiosity: "En la nota también hablamos de mitos y verdades, qué pasa con la testosterona y el cáncer de próstata, y por qué baja con la edad. Leé la nota completa 👇"

REGLAS ESTRICTAS DE LENGUAJE:
- PROHIBIDO usar palabras vulgares o groseras: "coger", "garchar", "levantar fierros", "mierda", etc.
- Usar lenguaje profesional pero cercano: "deseo sexual" (no "ganas de coger"), "actividad física" (no "levantar fierros").
- El tono es de un profesional de salud cercano, NO de un amigo en un bar.
- PROHIBIDO ser alarmista o sensacionalista. Nada de "mitos peligrosos", "lo que nadie te dice", etc.
- PROHIBIDO tratar al lector como ignorante o corregirlo: nada de "lo que no sabés", "más de lo que creés", "no lo que muchos creen", "no como muchos piensan", "no la explosión que crees". Dar el dato directo sin contrastar con lo que el lector supuestamente piensa.
- Subject y preheader: limpios (evitar sexo, sexual, erección — filtros de spam).
- Máximo 150 palabras en total (hook + value + curiosity).
- NO es un resumen. NO es el excerpt. NO es un pitch de venta.
- NUNCA usar "Dr." — solo "Mauro".
- Solo incluir datos que estén TEXTUALMENTE en el artículo. NUNCA inventar, suponer, inferir ni agregar información que no esté en la nota. Si el artículo no menciona algo, el email tampoco.
- Respondé SOLO con el JSON, sin markdown ni backticks.`
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  const copy: EmailCopy = JSON.parse(jsonStr);

  // Review step: validate copy quality and tone
  const reviewResponse = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Revisá este email de newsletter del Urólogo Mauro Carrillo. Tu trabajo es verificar que cumple con las reglas de estilo y corregirlo si no las cumple.

EMAIL GENERADO:
Subject: ${copy.subject}
Preheader: ${copy.preheader}
Hook: ${copy.hook}
Value: ${copy.value}
Curiosity: ${copy.curiosity}

CONTENIDO ORIGINAL DEL ARTÍCULO (para verificar datos):
${plainContent.slice(0, 2000)}

REGLAS A VERIFICAR:
1. NO contiene palabras vulgares: "coger", "garchar", "levantar fierros", "mierda", etc. → Reemplazar por términos profesionales.
2. NO es alarmista: nada de "mitos peligrosos", "lo que nadie te dice", "urgente", "peligro".
3. NO trata al lector como ignorante ni lo corrige: nada de "lo que no sabés", "más de lo que creés", "no lo que muchos creen", "no como muchos piensan". Dar datos directos sin contrastar con lo que el lector supuestamente piensa.
4. Todos los datos mencionados están TEXTUALMENTE en el artículo original — NO hay datos inventados, supuestos ni inferidos. Si un dato no aparece en el artículo, eliminarlo.
5. Subject y preheader NO contienen palabras como sexo, sexual, erección, pene, viagra (filtros de spam).
6. El tono es profesional-cercano, español rioplatense, sin ser vulgar.

Si todo está bien, devolvé el mismo JSON sin cambios.
Si algo viola las reglas, corregilo y devolvé el JSON corregido.

Respondé SOLO con el JSON corregido (misma estructura: preheader, hook, value, curiosity, subject), sin markdown ni backticks.`
    }],
  });

  const reviewText = reviewResponse.content[0].type === 'text' ? reviewResponse.content[0].text : '';
  const reviewJsonStr = reviewText.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    const reviewed = JSON.parse(reviewJsonStr);
    // Ensure all required fields exist, fallback to original if missing
    return {
      preheader: reviewed.preheader || copy.preheader,
      hook: reviewed.hook || copy.hook,
      value: reviewed.value || copy.value,
      curiosity: reviewed.curiosity || copy.curiosity,
      subject: reviewed.subject || copy.subject,
    };
  } catch {
    // If review JSON parsing fails, use original copy
    console.warn('Review step returned invalid JSON, using original copy');
    return copy;
  }
}

function buildNewsletterHtml(title: string, url: string, copy: EmailCopy): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
<!--[if mso]><span style="display:none !important; mso-hide:all;">
${copy.preheader}
</span><![endif]-->
<div style="display:none; max-height:0; overflow:hidden; mso-hide:all;">
${copy.preheader}
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4; padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:8px; overflow:hidden; max-width:600px; width:100%;">

<!-- Header -->
<tr><td style="background:#152735; padding:24px 30px; text-align:center;">
  <p style="margin:0; font-size:11px; letter-spacing:2px; color:#5ac8fa; text-transform:uppercase;">Nuevo en el blog</p>
  <h1 style="margin:8px 0 0; font-size:22px; color:#ffffff; font-weight:700; line-height:1.3;">${title}</h1>
</td></tr>

<!-- Accent line -->
<tr><td style="height:3px; background:linear-gradient(90deg,#5ac8fa,#48c9b0);"></td></tr>

<!-- Body -->
<tr><td style="padding:30px;">
  <p style="font-size:16px; color:#313131; line-height:1.7; margin:0 0 16px;">Hola,</p>
  <p style="font-size:16px; color:#313131; line-height:1.7; margin:0 0 16px;">
    ${copy.hook}
  </p>
  <p style="font-size:16px; color:#313131; line-height:1.7; margin:0 0 16px;">
    ${copy.value}
  </p>
  <p style="font-size:16px; color:#313131; line-height:1.7; margin:0 0 24px; font-style:italic;">
    ${copy.curiosity}
  </p>
  <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
    <tr><td style="background:#E67E22; border-radius:30px; text-align:center;">
      <a href="${url}" style="display:inline-block; padding:14px 36px; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600;">Leer la nota completa</a>
    </td></tr>
  </table>
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0 0 4px; font-size:14px; color:#313131; font-weight:700;">Mauro</p>
  <p style="margin:0; font-size:13px; color:#999999;">
    <a href="https://urologia.ar" style="color:#E67E22; text-decoration:none;">urologia.ar</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

async function alreadySentForPost(postId: number): Promise<boolean> {
  const tag = `newsletter-${postId}`;
  const res = await fetch(
    `https://api.brevo.com/v3/emailCampaigns?type=classic&status=sent&limit=50&sort=desc`,
    { headers: { 'api-key': BREVO_API_KEY } }
  );
  if (!res.ok) return false;
  const data = await res.json();
  return (data.campaigns || []).some((c: { tag?: string }) => c.tag === tag);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }

  try {
    // 1. Find latest published post with "newsletter" tag from last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const wpRes = await fetch(
      `https://urologia.ar/wp-json/wp/v2/posts?status=publish&orderby=date&per_page=1&after=${sevenDaysAgo}&tags=${NEWSLETTER_TAG_ID}&_fields=id,title,excerpt,content,link,slug,status`,
      { headers: { 'User-Agent': 'Nexo-mail/1.0' } }
    );

    if (!wpRes.ok) {
      return NextResponse.json({ success: false, skipped: true, reason: `WordPress returned ${wpRes.status}` });
    }

    const posts: WPPost[] = await wpRes.json();

    if (posts.length === 0) {
      return NextResponse.json({ success: true, skipped: true, reason: 'No new posts in the last 7 days' });
    }

    const post = posts[0];
    const title = stripHtml(post.title.rendered);
    const url = post.link || `https://urologia.ar/${post.slug}/`;

    // 2. Check duplicate (skip with ?force=true)
    const force = request.nextUrl.searchParams.get('force') === 'true';
    if (!force) {
      const sent = await alreadySentForPost(post.id);
      if (sent) {
        return NextResponse.json({
          success: true,
          skipped: true,
          reason: `Newsletter already sent for post ${post.id}`,
          postTitle: title,
        });
      }
    }

    // 3. Generate email copy with Claude
    const copy = await generateEmailCopy(title, post.content.rendered);

    // 4. Create Brevo campaign
    const today = new Date().toISOString().slice(0, 10);
    const campaignRes = await fetch('https://api.brevo.com/v3/emailCampaigns', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Newsletter: ${title} (${today})`,
        subject: copy.subject,
        sender: { email: 'info@urologia.ar', name: 'Urólogo Mauro Carrillo' },
        recipients: { listIds: [BLOG_LIST_ID] },
        htmlContent: buildNewsletterHtml(title, url, copy),
        replyTo: 'info@urologia.ar',
        tag: `newsletter-${post.id}`,
      }),
    });

    if (!campaignRes.ok) {
      const err = await campaignRes.text();
      console.error('Failed to create campaign:', err);
      return NextResponse.json({ success: false, error: 'Failed to create campaign', details: err }, { status: 502 });
    }

    const campaign = await campaignRes.json();
    const campaignId = campaign.id;

    // 5. Send immediately
    const sendRes = await fetch(
      `https://api.brevo.com/v3/emailCampaigns/${campaignId}/sendNow`,
      { method: 'POST', headers: { 'api-key': BREVO_API_KEY } }
    );

    if (!sendRes.ok) {
      const err = await sendRes.text();
      return NextResponse.json({ success: false, error: 'Campaign created but failed to send', campaignId, details: err }, { status: 502 });
    }

    console.log(`Newsletter sent: "${title}" (campaign ${campaignId}, post ${post.id})`);

    return NextResponse.json({
      success: true,
      campaignId,
      postId: post.id,
      postTitle: title,
      subject: copy.subject,
      sentToList: BLOG_LIST_ID,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('weekly-newsletter cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
