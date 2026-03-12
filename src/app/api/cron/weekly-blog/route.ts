import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const YOUTUBE_CHANNEL_ID = 'UC61wZRxQWvgNZX9Lf0rZ9WQ';
const WP_USER = 'REDACTED_USER';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const NEWSLETTER_TAG_ID = 125;

// Category mapping by topic keywords
const CATEGORY_MAP: Record<string, { id: number; name: string; playlist: string }> = {
  'disfuncion erectil|ereccion|erección|viagra|sildenafil|tadalafil|impotencia|ansiedad de desempeño': {
    id: 54, name: 'Disfunción Eréctil',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxD11jbMdy94TuMZdDjrwqqK',
  },
  'eyaculacion precoz|eyaculación precoz|durar mas|durar más|precoz': {
    id: 55, name: 'Eyaculación Precoz',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxA6EJThHIl6mg1SYDAfZC0y',
  },
  'preservativo|primera vez|libido|pornografia|pornografía|sexo oral|sexualidad': {
    id: 56, name: 'Salud Sexual',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxDOGD3tjyAj5uF5K7kF-1Gz',
  },
  'prostata|próstata|testiculo|testículo|varicocele|psa|hpb': {
    id: 57, name: 'Próstata y Testículos',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxBVOdl5GkcXpEoWmh9EsJt3',
  },
  'alcohol|droga|sustancia|ejercicio|sueño|habito|hábito|masturbacion|masturbación|testosterona|tabaco|cigarro': {
    id: 58, name: 'Hábitos y Estilo de Vida',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxBJnUT5nEzlfHtN0DjyQLW9',
  },
  'adolescen|pubertad|higiene|circuncision|fimosis|pene|vello|balanitis|frenillo': {
    id: 59, name: 'Adolescencia y Padres',
    playlist: 'https://youtube.com/playlist?list=PLEzuuIMYkfxDOGD3tjyAj5uF5K7kF-1Gz',
  },
};

// CTA mapping: categories with direct product vs general
const PRODUCT_CATEGORIES = [54, 55]; // DE and EP have lead magnets

interface YouTubeVideo {
  id: string;
  title: string;
  published: string;
  description: string;
}

interface CategoryInfo {
  id: number;
  name: string;
  playlist: string;
}

// ─── YouTube RSS ─────────────────────────────────────────────
async function getLatestVideo(): Promise<YouTubeVideo | null> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
  const res = await fetch(rssUrl);
  if (!res.ok) return null;

  const xml = await res.text();

  // Parse first entry from RSS XML
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;

  const entry = entryMatch[1];
  const id = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] || '';
  const title = entry.match(/<title>(.*?)<\/title>/)?.[1] || '';
  const published = entry.match(/<published>(.*?)<\/published>/)?.[1] || '';
  const description = entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '';

  return { id, title, published, description };
}

// ─── YouTube Transcript ──────────────────────────────────────
async function fetchTranscript(videoId: string): Promise<string> {
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'es' });
    return segments.map((s: { text: string }) => s.text).join(' ');
  } catch {
    // Fallback: try without language
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const segments = await YoutubeTranscript.fetchTranscript(videoId);
      return segments.map((s: { text: string }) => s.text).join(' ');
    } catch {
      return '';
    }
  }
}

// ─── Category Detection ──────────────────────────────────────
function detectCategory(title: string, description: string, transcript: string): CategoryInfo {
  const text = `${title} ${description} ${transcript.slice(0, 2000)}`.toLowerCase();

  for (const [keywords, info] of Object.entries(CATEGORY_MAP)) {
    const patterns = keywords.split('|');
    const matches = patterns.filter(p => text.includes(p)).length;
    if (matches >= 1) return info;
  }

  // Default
  return { id: 58, name: 'Hábitos y Estilo de Vida', playlist: CATEGORY_MAP[Object.keys(CATEGORY_MAP)[4]].playlist };
}

// ─── Claude Blog Generation ──────────────────────────────────
async function generateBlogPost(
  video: YouTubeVideo,
  transcript: string,
  category: CategoryInfo,
): Promise<{ title: string; slug: string; content: string; excerpt: string }> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const isProductCategory = PRODUCT_CATEGORIES.includes(category.id);

  const ctaBlock = isProductCategory && category.id === 54
    ? `<div style="background:#fafafa; border:1px solid #e0e0e0; border-radius:8px; padding:30px; margin:30px 0; text-align:center;">
  <h3 style="color:#111; margin-bottom:10px;">Guía gratuita: 5 Herramientas para No Perder la Erección</h3>
  <p style="color:#555; margin-bottom:20px;">Técnicas que podés aplicar esta misma semana. Sin pastillas.</p>
  <a href="https://urologia.ar/wp-content/uploads/2026/02/5_herramientas_lead_magnet.pdf" style="display:inline-block; background:#E67E22; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold;">Quiero recibirlo</a>
</div>`
    : isProductCategory && category.id === 55
    ? `<div style="background:#fafafa; border:1px solid #e0e0e0; border-radius:8px; padding:30px; margin:30px 0; text-align:center;">
  <h3 style="color:#111; margin-bottom:10px;">Guía gratuita: 3 Ejercicios para Controlar la Eyaculación</h3>
  <p style="color:#555; margin-bottom:20px;">Técnicas simples respaldadas por evidencia. Descargala gratis.</p>
  <a href="#" style="display:inline-block; background:#E67E22; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold;">Quiero recibirlo</a>
</div>`
    : `<div style="background:#fafafa; border:1px solid #e0e0e0; border-radius:8px; padding:30px; margin:30px 0; text-align:center;">
  <h3 style="color:#111; margin-bottom:10px;">¿Tenés dudas sobre este tema?</h3>
  <p style="color:#555; margin-bottom:20px;">Podés agendar una consulta urológica a distancia. Te atiendo de forma personalizada.</p>
  <a href="https://calendly.com/urologocarrillo" style="display:inline-block; background:#E67E22; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold;">Agendar consulta</a>
</div>`;

  const playlistBlock = !isProductCategory
    ? `<div style="background:#fafafa; border:1px solid #e0e0e0; border-radius:8px; padding:24px; margin:30px 0; text-align:center;">
  <h3 style="color:#111; margin-bottom:10px;">Seguí aprendiendo sobre ${category.name.toLowerCase()}</h3>
  <p style="color:#555; margin-bottom:15px;">Tengo más videos sobre este tema en mi canal de YouTube.</p>
  <a href="${category.playlist}" style="display:inline-block; background:#E67E22; color:#fff; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:bold;">Ver playlist completa en YouTube</a>
</div>`
    : '';

  const newsletterForm = `<div style="max-width:540px; margin:32px auto; padding:28px 24px; background:#fafafa; border:1px solid #e0e0e0; border-radius:8px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <h3 style="margin:0 0 8px; font-size:20px; font-weight:700; color:#1a1a1a; line-height:1.3;">Suscribite al blog</h3>
  <p style="margin:0 0 16px; font-size:15px; color:#555; line-height:1.5;">Recibí contenido sobre salud sexual masculina directo en tu correo.</p>
  <form id="form-newsletter" onsubmit="return handleNewsletterForm(event)" style="margin:0; padding:0;"><input type="text" name="_hp" style="position:absolute;left:-9999px;" tabindex="-1" autocomplete="off"><input type="email" name="email" placeholder="Tu email" required style="width:100%; box-sizing:border-box; padding:12px 14px; font-size:15px; border:1px solid #d0d0d0; border-radius:6px; margin:0 0 10px 0; outline:none; color:#1a1a1a; background:#fff;"><button type="submit" style="width:100%; padding:13px; font-size:16px; font-weight:600; color:#fff; background:#E67E22; border:none; border-radius:6px; cursor:pointer; margin:0;">Suscribirme</button><p class="form-msg" style="margin:10px 0 0; font-size:13px; text-align:center; color:#555; display:none;"></p></form>
  <p style="margin:12px 0 0; font-size:12px; color:#999; text-align:center;">Podés darte de baja cuando quieras.</p>
</div>
<script>
function handleNewsletterForm(e){e.preventDefault();var f=e.target,b=f.querySelector('button[type="submit"]'),m=f.querySelector('.form-msg'),em=f.querySelector('input[name="email"]').value.trim(),hp=f.querySelector('input[name="_hp"]').value;b.disabled=true;b.textContent='Enviando...';b.style.opacity='0.7';fetch('https://nexo-mail.vercel.app/api/form/blog',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:em,tag:'blog-suscriptor',_hp:hp})}).then(function(r){return r.json()}).then(function(d){if(d.success){m.style.display='block';m.style.color='#2d8659';m.textContent='¡Suscrito! Vas a recibir las notas nuevas del blog.';em='';f.querySelector('input[name="email"]').value='';b.textContent='✓ Enviado';b.style.background='#2d8659'}else{m.style.display='block';m.style.color='#c0392b';m.textContent=d.error||'Hubo un error. Intentá de nuevo.';b.disabled=false;b.textContent='Reintentar';b.style.opacity='1'}}).catch(function(){m.style.display='block';m.style.color='#c0392b';m.textContent='Error de conexión. Intentá de nuevo.';b.disabled=false;b.textContent='Reintentar';b.style.opacity='1'});return false}
</script>`;

  const prompt = `Sos un redactor médico SEO que escribe para el Urólogo Mauro Carrillo (urologia.ar). Generá un artículo de blog a partir de este video de YouTube.

VIDEO: "${video.title}"
VIDEO_ID: ${video.id}
CATEGORÍA: ${category.name}

TRANSCRIPCIÓN:
${transcript.slice(0, 12000)}

INSTRUCCIONES:
1. Generá un JSON con esta estructura exacta:
{
  "title": "Título SEO neutro con keyword principal, <60 caracteres",
  "slug": "keyword-principal-3-5-palabras",
  "excerpt": "Meta description <155 chars, hook + keyword, genera curiosidad",
  "content": "HTML completo del artículo"
}

2. El "content" debe seguir esta estructura HTML exacta (sin <html>, <head>, <body> — solo el contenido):

- INTRO: 2-3 párrafos con hook + contexto. Tono rioplatense (vos, tenés). Keyword natural.
- VIDEO EMBED (copiar exacto):
<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; margin:20px 0;">
  <iframe src="https://www.youtube.com/embed/${video.id}" style="position:absolute; top:0; left:0; width:100%; height:100%; border:none;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
</div>

- 3-5 SECCIONES H2: Contenido REESCRITO (no transcripción literal). Narrativa fluida para lectura web. Párrafos cortos (2-3 oraciones). Datos y estudios con fuente cuando haya.
- Al menos 1 lista o tabla con DATOS CONCRETOS por artículo.

- CTA PRINCIPAL (copiar exacto después de la sección 2):
${ctaBlock}

- H2 PREGUNTAS FRECUENTES: 3-5 preguntas en formato H3 dentro del H2. Optimizado para Featured Snippets.

${playlistBlock ? `- CTA SECUNDARIO (copiar exacto después de las FAQ):\n${playlistBlock}` : ''}

- CIERRE: Párrafo final con resumen + CTA sutil.

- FORMULARIO NEWSLETTER (copiar exacto antes de la firma):
${newsletterForm}

- FIRMA (copiar exacto):
<div style="padding:20px 0; border-top:1px solid #e0e0e0; margin-top:20px; display:flex; align-items:center; justify-content:space-between;">
  <strong style="font-size:16px; color:#111;">Urólogo Mauro Carrillo</strong>
  <span style="font-size:14px;">
    <a href="https://youtube.com/@urologocarrillo" style="color:#E67E22; text-decoration:none; margin-right:15px;">YouTube</a>
    <a href="https://calendly.com/urologocarrillo" style="color:#E67E22; text-decoration:none;">Atención a distancia</a>
  </span>
</div>

REGLAS:
- Títulos/H1 neutros (sin rioplatense). Cuerpo en rioplatense.
- NO es transcripción literal — REESCRIBIR con narrativa fluida.
- Párrafos de 2-3 oraciones máximo.
- Orange (#E67E22) solo para links y botones CTA.
- Firma: "Urólogo Mauro Carrillo" (NUNCA "Dr.").
- 1,500-2,500 palabras.
- El JSON debe ser válido. Escapar comillas dentro del content con \\".

Respondé SOLO con el JSON, sin markdown ni backticks.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Parse JSON response - handle potential markdown wrapping
  const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
  const parsed = JSON.parse(jsonStr);

  return {
    title: parsed.title,
    slug: parsed.slug,
    content: parsed.content,
    excerpt: parsed.excerpt,
  };
}

// ─── WordPress Publishing ────────────────────────────────────
async function publishToWordPress(
  title: string,
  slug: string,
  content: string,
  excerpt: string,
  categoryId: number,
  videoId: string,
): Promise<{ postId: number; link: string }> {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  // 1. Upload YouTube thumbnail as featured image
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  let featuredMediaId: number | undefined;

  try {
    const imgRes = await fetch(thumbUrl);
    if (imgRes.ok) {
      const imgBuffer = await imgRes.arrayBuffer();
      const uploadRes = await fetch('https://urologia.ar/wp-json/wp/v2/media', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Disposition': `attachment; filename="${slug}-thumbnail.jpg"`,
          'Content-Type': 'image/jpeg',
        },
        body: Buffer.from(imgBuffer),
      });
      if (uploadRes.ok) {
        const media = await uploadRes.json();
        featuredMediaId = media.id;
      }
    }
  } catch {
    // Thumbnail upload failed — continue without it
  }

  // 2. Create published post
  const postData: Record<string, unknown> = {
    title,
    content,
    slug,
    excerpt,
    status: 'publish',
    categories: [categoryId],
    tags: [NEWSLETTER_TAG_ID],
  };

  if (featuredMediaId) {
    postData.featured_media = featuredMediaId;
  }

  const postRes = await fetch('https://urologia.ar/wp-json/wp/v2/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(postData),
  });

  if (!postRes.ok) {
    const err = await postRes.json();
    throw new Error(`WordPress error: ${JSON.stringify(err)}`);
  }

  const post = await postRes.json();

  // 3. Validate: check for escaped quotes in content
  const validateRes = await fetch(
    `https://urologia.ar/wp-json/wp/v2/posts/${post.id}?context=edit`,
    { headers: { 'Authorization': `Basic ${auth}` } }
  );

  if (validateRes.ok) {
    const validated = await validateRes.json();
    const raw = validated.content?.raw || '';
    if (raw.includes('\\"') || raw.includes('\\n')) {
      // Fix escaped content
      const cleaned = raw.replace(/\\"/g, '"').replace(/\\n/g, '\n');
      await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${post.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: cleaned }),
      });
    }
  }

  return { postId: post.id, link: post.link };
}

// ─── Duplicate Check ─────────────────────────────────────────
async function alreadyPublishedForVideo(videoId: string): Promise<boolean> {
  // Check if a post with this video embed already exists in the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  const res = await fetch(
    `https://urologia.ar/wp-json/wp/v2/posts?status=publish&tags=${NEWSLETTER_TAG_ID}&after=${sevenDaysAgo}&per_page=5&_fields=id,content`,
    { headers: { 'Authorization': `Basic ${auth}` } }
  );

  if (!res.ok) return false;
  const posts = await res.json();

  return posts.some((p: { content?: { rendered?: string } }) =>
    p.content?.rendered?.includes(videoId)
  );
}

// ─── Main Handler ────────────────────────────────────────────
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check required env vars
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }
  if (!WP_APP_PASSWORD) {
    return NextResponse.json({ success: false, error: 'WP_APP_PASSWORD not configured' }, { status: 500 });
  }

  try {
    // 1. Get latest YouTube video
    const video = await getLatestVideo();
    if (!video) {
      return NextResponse.json({ success: true, skipped: true, reason: 'Could not fetch YouTube RSS' });
    }

    // Check if video is from the last 2 days
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const videoDate = new Date(video.published).getTime();
    if (videoDate < twoDaysAgo) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No new video in the last 2 days',
        lastVideo: { title: video.title, published: video.published },
      });
    }

    // 2. Check duplicate
    const alreadyDone = await alreadyPublishedForVideo(video.id);
    if (alreadyDone) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: `Blog post already exists for video ${video.id}`,
        videoTitle: video.title,
      });
    }

    // 3. Get transcript
    const transcript = await fetchTranscript(video.id);
    if (!transcript || transcript.length < 200) {
      console.log(`Transcript too short or missing for ${video.id}, using description`);
    }

    const sourceText = transcript.length > 200 ? transcript : video.description;
    if (!sourceText || sourceText.length < 100) {
      return NextResponse.json({
        success: false,
        error: 'No transcript or description available for blog generation',
        videoId: video.id,
        videoTitle: video.title,
      });
    }

    // 4. Detect category
    const category = detectCategory(video.title, video.description, sourceText);

    // 5. Generate blog post via Claude
    const blogPost = await generateBlogPost(video, sourceText, category);

    // 6. Publish to WordPress
    const { postId, link } = await publishToWordPress(
      blogPost.title,
      blogPost.slug,
      blogPost.content,
      blogPost.excerpt,
      category.id,
      video.id,
    );

    console.log(`Blog published: "${blogPost.title}" (post ${postId}) for video ${video.id}`);

    return NextResponse.json({
      success: true,
      postId,
      postLink: link,
      postTitle: blogPost.title,
      videoId: video.id,
      videoTitle: video.title,
      category: category.name,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('weekly-blog cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
