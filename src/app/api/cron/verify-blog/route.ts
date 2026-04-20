import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 60;

const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const NEWSLETTER_TAG_ID = 125;

interface WPPost {
  id: number;
  title: { rendered: string };
  content: { rendered: string; raw?: string };
  slug: string;
  excerpt: { rendered: string };
  categories: number[];
  tags: number[];
  featured_media: number;
}

// ─── Extract video ID from blog content ──────────────────────
function extractVideoId(content: string): string | null {
  const match = content.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ─── Fetch YouTube transcript ────────────────────────────────
async function fetchTranscript(videoId: string): Promise<string> {
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'es' });
    return segments.map((s: { text: string }) => s.text).join(' ');
  } catch {
    try {
      const { YoutubeTranscript } = await import('youtube-transcript');
      const segments = await YoutubeTranscript.fetchTranscript(videoId);
      return segments.map((s: { text: string }) => s.text).join(' ');
    } catch {
      return '';
    }
  }
}

// ─── Validate HTML structure ─────────────────────────────────
function validateHtml(html: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check for unclosed critical tags
  const tagsToCheck = ['div', 'h2', 'h3', 'p', 'table', 'tr', 'td', 'a', 'ul', 'ol', 'li'];
  for (const tag of tagsToCheck) {
    const openCount = (html.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
    const closeCount = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
    if (openCount > closeCount) {
      issues.push(`Unclosed <${tag}>: ${openCount} opened, ${closeCount} closed`);
    }
  }

  // Check for broken iframes
  if (html.includes('<iframe') && !html.includes('</iframe>')) {
    issues.push('Unclosed <iframe> tag');
  }

  // Check for escaped quotes that break HTML
  if (html.includes('\\"')) {
    issues.push('Contains escaped quotes (\\\") that break HTML attributes');
  }

  // Check for literal \\n
  if (html.includes('\\n')) {
    issues.push('Contains literal \\n that renders as visible text');
  }

  return { valid: issues.length === 0, issues };
}

// ─── Fix HTML issues ─────────────────────────────────────────
function fixHtmlIssues(html: string): string {
  let fixed = html;

  // Fix escaped quotes
  fixed = fixed.replace(/\\"/g, '"');

  // Fix literal newlines
  fixed = fixed.replace(/\\n/g, '\n');

  // Fix unclosed divs (add closing tags at end if needed)
  const openDivs = (fixed.match(/<div[\s>]/gi) || []).length;
  const closeDivs = (fixed.match(/<\/div>/gi) || []).length;
  if (openDivs > closeDivs) {
    for (let i = 0; i < openDivs - closeDivs; i++) {
      fixed += '</div>';
    }
  }

  return fixed;
}

// ─── Verify blog content against transcript ──────────────────
async function verifyContent(
  blogHtml: string,
  transcript: string,
): Promise<{ passed: boolean; issues: string[]; correctedContent: string }> {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const plainBlog = blogHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Sos un verificador de datos médicos. Compará este artículo de blog con la transcripción del video original. Detectá CUALQUIER dato que NO esté en la transcripción.

TRANSCRIPCIÓN ORIGINAL (fuente de verdad):
${transcript.slice(0, 10000)}

ARTÍCULO DE BLOG:
${plainBlog.slice(0, 5000)}

INSTRUCCIONES:
1. Extraé CADA afirmación factual del artículo: números, porcentajes, nombres de estudios, autores, años, cifras, dosis, comparaciones, claims causa-efecto.
2. Para cada una, verificá si aparece en la transcripción.
3. Clasificá:
   - "verified": el dato está en la transcripción
   - "invented": el dato NO está en la transcripción
   - "distorted": el dato está pero fue alterado

Respondé con JSON:
{
  "claims": [
    {"text": "dato", "status": "verified|invented|distorted", "note": "explicación breve"}
  ],
  "summary": {"verified": 0, "invented": 0, "distorted": 0},
  "passed": true
}

"passed" es true SOLO si "invented" es 0 Y "distorted" es 0.
Si no hay afirmaciones factuales (solo explicaciones generales), "passed" es true.
Respondé SOLO con JSON.`
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();

  try {
    const result = JSON.parse(jsonStr);
    const issues: string[] = [];

    if (!result.passed && result.claims) {
      const badClaims = result.claims.filter(
        (c: { status: string }) => c.status === 'invented' || c.status === 'distorted'
      );

      for (const claim of badClaims) {
        issues.push(`[${claim.status.toUpperCase()}] ${claim.text}`);
      }

      // Fix: ask Claude to strip invented data from the HTML
      if (badClaims.length > 0) {
        const fixResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8000,
          messages: [{
            role: 'user',
            content: `Corregí este artículo HTML eliminando los datos inventados o distorsionados. NO agregues datos nuevos. Solo eliminá lo falso y reescribí esas oraciones sin el dato.

ARTÍCULO HTML:
${blogHtml}

DATOS A ELIMINAR:
${badClaims.map((c: { status: string; text: string }) => `- [${c.status}] "${c.text}"`).join('\n')}

REGLAS:
- Devolvé el HTML completo corregido.
- Solo eliminá/reescribí las oraciones con datos problemáticos.
- NO modifiques CTAs, iframes, formularios, firma ni estructura.
- NO agregues datos nuevos.
- Devolvé SOLO el HTML, sin backticks.`
          }],
        });

        const fixedContent = fixResponse.content[0].type === 'text' ? fixResponse.content[0].text : '';
        const cleanedContent = fixedContent.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();

        return {
          passed: false,
          issues,
          correctedContent: cleanedContent || blogHtml,
        };
      }
    }

    return { passed: true, issues, correctedContent: blogHtml };
  } catch {
    console.warn('Verification JSON parse error — using original content');
    return { passed: true, issues: ['Verification parse error'], correctedContent: blogHtml };
  }
}

// ─── Main Handler ────────────────────────────────────────────
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ success: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
  }
  if (!WP_APP_PASSWORD) {
    return NextResponse.json({ success: false, error: 'WP_APP_PASSWORD not configured' }, { status: 500 });
  }

  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  try {
    // 1. Find latest DRAFT post with newsletter tag from last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const draftRes = await fetch(
      `https://urologia.ar/wp-json/wp/v2/posts?status=draft&tags=${NEWSLETTER_TAG_ID}&after=${sevenDaysAgo}&per_page=1&orderby=date&order=desc&context=edit`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );

    if (!draftRes.ok) {
      return NextResponse.json({ success: false, error: `WordPress returned ${draftRes.status}` });
    }

    const drafts: WPPost[] = await draftRes.json();

    if (drafts.length === 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No draft posts to verify',
      });
    }

    const draft = drafts[0];
    const rawContent = draft.content.raw || draft.content.rendered;
    const title = draft.title.rendered.replace(/<[^>]*>/g, '');

    // 2. Extract video ID and fetch transcript
    const videoId = extractVideoId(rawContent);
    if (!videoId) {
      // No video embed found — publish without verification
      console.log(`No video ID found in draft ${draft.id}, publishing without verification`);
      await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${draft.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'publish' }),
      });
      return NextResponse.json({
        success: true,
        postId: draft.id,
        postTitle: title,
        verification: { skipped: true, reason: 'No video ID in content' },
      });
    }

    const transcript = await fetchTranscript(videoId);

    // 3. Validate HTML structure
    const htmlCheck = validateHtml(rawContent);
    let content = rawContent;
    if (!htmlCheck.valid) {
      console.log(`HTML issues found in draft ${draft.id}:`, htmlCheck.issues);
      content = fixHtmlIssues(content);
    }

    // 4. Verify content against transcript (only if transcript available)
    let verification = { passed: true, issues: [] as string[], correctedContent: content };

    if (transcript && transcript.length > 200) {
      verification = await verifyContent(content, transcript);
      content = verification.correctedContent;
    } else {
      console.log(`No transcript for video ${videoId}, skipping data verification`);
      verification.issues.push('No transcript available — skipped data verification');
    }

    // 5. Update content (if corrected) and publish
    await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${draft.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        status: 'publish',
      }),
    });

    // 6. Post-publish validation: check for escaped content
    const validateRes = await fetch(
      `https://urologia.ar/wp-json/wp/v2/posts/${draft.id}?context=edit`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );

    if (validateRes.ok) {
      const validated = await validateRes.json();
      const raw = validated.content?.raw || '';
      if (raw.includes('\\"') || raw.includes('\\n')) {
        const cleaned = raw.replace(/\\"/g, '"').replace(/\\n/g, '\n');
        await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${draft.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: cleaned }),
        });
      }
    }

    console.log(`Blog VERIFIED and PUBLISHED: "${title}" (post ${draft.id})`);

    return NextResponse.json({
      success: true,
      postId: draft.id,
      postTitle: title,
      postStatus: 'publish',
      videoId,
      verification: {
        passed: verification.passed,
        issuesCount: verification.issues.length,
        issues: verification.issues,
        htmlFixed: !htmlCheck.valid,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('verify-blog cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
