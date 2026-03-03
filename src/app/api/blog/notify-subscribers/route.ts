import { NextRequest, NextResponse } from 'next/server';

const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const NEXO_API_KEY = process.env.API_KEY || '';
const BLOG_LIST_ID = 29; // Suscriptores Blog

interface WPPost {
  id: number;
  title: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  slug: string;
  status: string;
  categories: number[];
  featured_media: number;
}

interface BrevoCampaign {
  id: number;
  name: string;
  status: string;
  tag: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function buildEmailHtml(post: WPPost): string {
  const title = stripHtml(post.title.rendered);
  const excerpt = stripHtml(post.excerpt.rendered);
  const url = post.link || `https://urologia.ar/${post.slug}/`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family:Arial,Helvetica,sans-serif;">
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
  <p style="font-size:16px; color:#313131; line-height:1.7; margin:0 0 20px;">
    ${excerpt}
  </p>
  <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
    <tr><td style="background:#E67E22; border-radius:30px; text-align:center;">
      <a href="${url}" style="display:inline-block; padding:14px 36px; color:#ffffff; text-decoration:none; font-size:16px; font-weight:600;">Leer la nota completa</a>
    </td></tr>
  </table>
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 30px; border-top:1px solid #e0e0e0; text-align:center;">
  <p style="margin:0 0 4px; font-size:14px; color:#313131; font-weight:700;">Urólogo Mauro Carrillo</p>
  <p style="margin:0; font-size:13px; color:#999999;">
    <a href="https://youtube.com/@urologocarrillo" style="color:#E67E22; text-decoration:none;">YouTube</a> &nbsp;|&nbsp;
    <a href="https://urologia.ar" style="color:#E67E22; text-decoration:none;">urologia.ar</a> &nbsp;|&nbsp;
    <a href="https://calendly.com/urologocarrillo" style="color:#E67E22; text-decoration:none;">Consulta a distancia</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

// Check if a campaign was already sent for this postId
async function alreadySentForPost(postId: number): Promise<boolean> {
  const tag = `blog-post-${postId}`;
  const res = await fetch(
    `https://api.brevo.com/v3/emailCampaigns?type=classic&status=sent&tag=${tag}&limit=1`,
    { headers: { 'api-key': BREVO_API_KEY } }
  );
  if (!res.ok) return false;
  const data = await res.json();
  return (data.campaigns?.length || 0) > 0;
}

export async function POST(request: NextRequest) {
  // Auth check
  const authHeader = request.headers.get('x-api-key');
  if (authHeader !== NEXO_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { postId, force } = body;

  if (!postId) {
    return NextResponse.json({ error: 'postId is required' }, { status: 400 });
  }

  try {
    // 1. Fetch post from WordPress
    const wpRes = await fetch(
      `https://urologia.ar/wp-json/wp/v2/posts/${postId}?_fields=id,title,excerpt,link,slug,status,categories,featured_media`,
      { headers: { 'User-Agent': 'Nexo-mail/1.0' } }
    );

    if (!wpRes.ok) {
      return NextResponse.json({ error: `WordPress returned ${wpRes.status}` }, { status: 502 });
    }

    const post: WPPost = await wpRes.json();
    const title = stripHtml(post.title.rendered);

    // Safety: only send for published posts
    if (post.status !== 'publish') {
      return NextResponse.json({
        error: `Post is "${post.status}", not "publish". Newsletter only sends for published posts.`,
        postId,
        postStatus: post.status,
      }, { status: 400 });
    }

    // Duplicate protection: check if already sent for this postId
    if (!force) {
      const sent = await alreadySentForPost(postId);
      if (sent) {
        return NextResponse.json({
          error: 'Newsletter already sent for this post. Use force:true to override.',
          postId,
          postTitle: title,
          alreadySent: true,
        }, { status: 409 });
      }
    }

    // 2. Create Brevo campaign (tag includes postId for duplicate detection)
    const campaignRes = await fetch('https://api.brevo.com/v3/emailCampaigns', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `Blog: ${title} (${new Date().toISOString().slice(0, 10)})`,
        subject: title,
        sender: { email: 'info@urologia.ar', name: 'Urólogo Mauro Carrillo' },
        recipients: { listIds: [BLOG_LIST_ID] },
        htmlContent: buildEmailHtml(post),
        replyTo: 'info@urologia.ar',
        tag: `blog-post-${postId}`,
      }),
    });

    if (!campaignRes.ok) {
      const err = await campaignRes.json();
      return NextResponse.json({ error: 'Failed to create campaign', details: err }, { status: 502 });
    }

    const campaign = await campaignRes.json();
    const campaignId = campaign.id;

    // 3. Send the campaign immediately
    const sendRes = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/sendNow`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY },
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      return NextResponse.json({
        error: 'Campaign created but failed to send',
        campaignId,
        details: err,
      }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      campaignId,
      postId,
      postTitle: title,
      sentToList: BLOG_LIST_ID,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('notify-subscribers error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
