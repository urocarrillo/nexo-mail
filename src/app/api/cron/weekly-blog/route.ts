import { NextRequest, NextResponse } from 'next/server';
import * as Brevo from '@getbrevo/brevo';

export const maxDuration = 30;

const YOUTUBE_CHANNEL_ID = 'UC61wZRxQWvgNZX9Lf0rZ9WQ';
const WP_USER = 'REDACTED_USER';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const NEWSLETTER_TAG_ID = 125;
const VIDEO_PLACEHOLDER = '{{YOUTUBE_EMBED}}';
const ALERT_EMAIL = 'REDACTED_EMAIL@example.com';

interface YouTubeVideo {
  id: string;
  title: string;
  published: string;
}

// ─── YouTube RSS ─────────────────────────────────────────────
async function getLatestVideo(): Promise<YouTubeVideo | null> {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
  const res = await fetch(rssUrl);
  if (!res.ok) return null;

  const xml = await res.text();
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;

  const entry = entryMatch[1];
  return {
    id: entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] || '',
    title: entry.match(/<title>(.*?)<\/title>/)?.[1] || '',
    published: entry.match(/<published>(.*?)<\/published>/)?.[1] || '',
  };
}

// ─── Extract publication date from BLOG-META comment ─────────
function extractPublicationDate(content: string): string | null {
  const match = content.match(/fecha_publicacion:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// ─── Check if date is within range of video publish date ─────
function dateMatchesVideo(blogDate: string, videoPublished: string): boolean {
  const blog = new Date(blogDate).getTime();
  const video = new Date(videoPublished).getTime();
  // Allow 5 days of tolerance (blog date might be slightly off)
  const fiveDays = 5 * 24 * 60 * 60 * 1000;
  return Math.abs(blog - video) <= fiveDays;
}

// ─── Find draft with video placeholder ───────────────────────
async function findDraftWithPlaceholder(
  auth: string,
  videoPublished: string,
): Promise<{ id: number; contentRaw: string; title: string } | null> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://urologia.ar/wp-json/wp/v2/posts?status=draft&tags=${NEWSLETTER_TAG_ID}&after=${thirtyDaysAgo}&per_page=10&context=edit`,
    { headers: { Authorization: `Basic ${auth}` } },
  );

  if (!res.ok) return null;
  const posts = await res.json();

  // First pass: find draft with placeholder AND matching date
  for (const post of posts) {
    const raw = post.content?.raw || '';
    if (raw.includes(VIDEO_PLACEHOLDER)) {
      const blogDate = extractPublicationDate(raw);
      if (blogDate && dateMatchesVideo(blogDate, videoPublished)) {
        return {
          id: post.id,
          contentRaw: raw,
          title: post.title?.raw || post.title?.rendered || '',
        };
      }
    }
  }

  // Second pass: if no date match, fall back to any draft with placeholder
  // (backwards compatibility for drafts without fecha_publicacion)
  for (const post of posts) {
    const raw = post.content?.raw || '';
    if (raw.includes(VIDEO_PLACEHOLDER)) {
      return {
        id: post.id,
        contentRaw: raw,
        title: post.title?.raw || post.title?.rendered || '',
      };
    }
  }

  return null;
}

// ─── Check duplicate ─────────────────────────────────────────
async function alreadyPublishedForVideo(auth: string, videoId: string): Promise<boolean> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://urologia.ar/wp-json/wp/v2/posts?status=publish&tags=${NEWSLETTER_TAG_ID}&after=${sevenDaysAgo}&per_page=5&_fields=id,content`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!res.ok) return false;
  const posts = await res.json();
  return posts.some(
    (p: { content?: { rendered?: string } }) => p.content?.rendered?.includes(videoId),
  );
}

// ─── Safety net: revert published posts that still have placeholder ──
async function revertBrokenPublishedPosts(auth: string): Promise<string[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://urologia.ar/wp-json/wp/v2/posts?status=publish&tags=${NEWSLETTER_TAG_ID}&after=${sevenDaysAgo}&per_page=10&context=edit`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  if (!res.ok) return [];
  const posts = await res.json();
  const reverted: string[] = [];

  for (const post of posts) {
    const raw = post.content?.raw || '';
    if (raw.includes(VIDEO_PLACEHOLDER)) {
      // This post was published with the placeholder still in it — revert to draft
      await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${post.id}`, {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'draft' }),
      });
      reverted.push(`Post ${post.id}: "${post.title?.raw}" reverted to draft`);
      console.log(`Safety net: reverted post ${post.id} to draft (had placeholder while published)`);
    }
  }
  return reverted;
}

// ─── Alert: no draft found for new video ─────────────────────
async function sendNoDraftAlert(videoTitle: string, videoId: string): Promise<void> {
  if (!BREVO_API_KEY) return;
  const transacApi = new Brevo.TransactionalEmailsApi();
  transacApi.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

  const email = new Brevo.SendSmtpEmail();
  email.sender = { name: 'Nexo-mail', email: 'info@urologia.ar' };
  email.to = [{ email: ALERT_EMAIL }];
  email.subject = `⚠️ Blog: no hay draft para "${videoTitle}"`;
  email.htmlContent = `
    <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; padding:24px;">
      <h2 style="color:#152735; margin-bottom:16px;">No se encontró draft de blog</h2>
      <p style="color:#313131; font-size:15px; line-height:1.6;">
        El cron <strong>weekly-blog</strong> detectó un video nuevo en YouTube pero no encontró ningún draft en WordPress con el placeholder <code>{{YOUTUBE_EMBED}}</code>.
      </p>
      <table style="width:100%; border-collapse:collapse; margin:20px 0;">
        <tr style="background:#f8f9fa;">
          <td style="padding:10px; font-weight:bold; color:#666;">Video</td>
          <td style="padding:10px; color:#313131;">${videoTitle}</td>
        </tr>
        <tr>
          <td style="padding:10px; font-weight:bold; color:#666;">Video ID</td>
          <td style="padding:10px;"><a href="https://youtube.com/watch?v=${videoId}" style="color:#E67E22;">${videoId}</a></td>
        </tr>
      </table>
      <p style="color:#313131; font-size:15px; line-height:1.6;">
        <strong>Qué hacer:</strong> Ejecutá <code>/publicar-blog</code> en Claude Code para subir el draft a WordPress. El cron de backup del martes lo va a publicar automáticamente.
      </p>
      <p style="color:#999; font-size:13px; margin-top:24px;">— Nexo-mail (cron automático)</p>
    </div>`;

  try {
    await transacApi.sendTransacEmail(email);
    console.log(`Alert email sent: no draft for video "${videoTitle}"`);
  } catch (err) {
    console.error('Failed to send no-draft alert:', err);
  }
}

// ─── Main Handler ────────────────────────────────────────────
export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!WP_APP_PASSWORD) {
    return NextResponse.json(
      { success: false, error: 'WP_APP_PASSWORD not configured' },
      { status: 500 },
    );
  }

  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  try {
    // 0. Safety net: revert any published posts that still have the placeholder
    const reverted = await revertBrokenPublishedPosts(auth);

    // 1. Get latest YouTube video
    const video = await getLatestVideo();
    if (!video) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'Could not fetch YouTube RSS',
        safetyNet: reverted.length > 0 ? reverted : undefined,
      });
    }

    // 2. Check if video is from the last 3 days (generous window for premieres)
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    if (new Date(video.published).getTime() < threeDaysAgo) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No new video in the last 3 days',
        lastVideo: { title: video.title, published: video.published },
        safetyNet: reverted.length > 0 ? reverted : undefined,
      });
    }

    // 3. Check duplicate (already published for this video)
    if (await alreadyPublishedForVideo(auth, video.id)) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: `Post already published for video ${video.id}`,
        safetyNet: reverted.length > 0 ? reverted : undefined,
      });
    }

    // 4. Find draft with placeholder (prefer date-matched)
    const draft = await findDraftWithPlaceholder(auth, video.published);
    if (!draft) {
      await sendNoDraftAlert(video.title, video.id);
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'No draft found with {{YOUTUBE_EMBED}} placeholder',
        hint: 'Run /publicar-blog to upload the blog draft to WordPress',
        videoTitle: video.title,
        alertSent: true,
      });
    }

    // 5. Replace placeholder with actual YouTube embed
    const youtubeEmbed = `<div style="position:relative; padding-bottom:56.25%; height:0; overflow:hidden; margin:20px 0;">
  <iframe src="https://www.youtube.com/embed/${video.id}" style="position:absolute; top:0; left:0; width:100%; height:100%; border:none;" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
</div>`;

    const updatedContent = draft.contentRaw.replace(VIDEO_PLACEHOLDER, youtubeEmbed);

    // 6. Upload YouTube thumbnail as featured image
    let featuredMediaId: number | undefined;
    try {
      const thumbUrl = `https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`;
      const imgRes = await fetch(thumbUrl);
      if (imgRes.ok) {
        const imgBuffer = await imgRes.arrayBuffer();
        const slug = draft.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+$/, '')
          .slice(0, 50);
        const uploadRes = await fetch('https://urologia.ar/wp-json/wp/v2/media', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
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

    // 7. Update post: replace content + thumbnail + publish + set date to now
    const updateData: Record<string, unknown> = {
      content: updatedContent,
      status: 'publish',
      date: new Date().toISOString(),
    };
    if (featuredMediaId) {
      updateData.featured_media = featuredMediaId;
    }

    const updateRes = await fetch(`https://urologia.ar/wp-json/wp/v2/posts/${draft.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updateData),
    });

    if (!updateRes.ok) {
      const err = await updateRes.json();
      throw new Error(`WordPress update error: ${JSON.stringify(err)}`);
    }

    const updatedPost = await updateRes.json();

    console.log(
      `Blog published: "${draft.title}" (post ${draft.id}) with video ${video.id}`,
    );

    return NextResponse.json({
      success: true,
      postId: draft.id,
      postTitle: draft.title,
      postLink: updatedPost.link,
      videoId: video.id,
      videoTitle: video.title,
      thumbnailUploaded: !!featuredMediaId,
      timestamp: new Date().toISOString(),
      safetyNet: reverted.length > 0 ? reverted : undefined,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('weekly-blog cron error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
