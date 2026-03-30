// ─── Zernio API client for LinkedIn posting ─────────────────────────
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || '';
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';
const LINKEDIN_ACCOUNT_ID = '69caa16846f99a61a77a7f9c';
const TIMEZONE = 'America/Argentina/Mendoza';

interface ZernioPost {
  id: string;
  content: string;
  status: string;
  platforms: Array<{ platform: string; accountId: string }>;
  scheduledFor?: string;
  createdAt: string;
}

interface ZernioResponse {
  success: boolean;
  data?: ZernioPost;
  error?: string;
}

interface ZernioListResponse {
  success: boolean;
  data?: ZernioPost[];
  error?: string;
}

interface ZernioHealthResponse {
  success: boolean;
  data?: {
    platform: string;
    accountId: string;
    status: string;
    connectedAt?: string;
    expiresAt?: string;
  };
  error?: string;
}

interface PresignResponse {
  uploadUrl: string;
  publicUrl: string;
}

async function zernioFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${ZERNIO_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zernio API error ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Publish a text post to LinkedIn.
 */
export async function publishPost(
  content: string,
  publishNow = true,
  scheduledFor?: string,
  firstComment?: string
): Promise<ZernioResponse> {
  try {
    const body: Record<string, unknown> = {
      content,
      platforms: [{ platform: 'linkedin', accountId: LINKEDIN_ACCOUNT_ID }],
    };

    if (publishNow) {
      body.publishNow = true;
    } else if (scheduledFor) {
      body.scheduledFor = scheduledFor;
      body.timezone = TIMEZONE;
    }

    if (firstComment) {
      body.platformSpecificData = {
        linkedin: { firstComment },
      };
    }

    const data = await zernioFetch<ZernioPost>('/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return { success: true, data };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn publishPost error:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Publish a post with an image to LinkedIn.
 * First uploads the image via presigned URL, then creates the post.
 */
export async function publishPostWithImage(
  content: string,
  imageUrl: string,
  publishNow = true,
  firstComment?: string
): Promise<ZernioResponse> {
  try {
    // 1. Get presigned upload URL
    const presign = await zernioFetch<PresignResponse>('/media/presign', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    // 2. Download the image
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      throw new Error(`Failed to download image from ${imageUrl}: ${imageRes.status}`);
    }
    const imageBuffer = await imageRes.arrayBuffer();

    // 3. Upload to presigned URL
    const uploadRes = await fetch(presign.uploadUrl, {
      method: 'PUT',
      body: imageBuffer,
      headers: {
        'Content-Type': imageRes.headers.get('content-type') || 'image/jpeg',
      },
    });

    if (!uploadRes.ok) {
      throw new Error(`Failed to upload image: ${uploadRes.status}`);
    }

    // 4. Create post with media
    const body: Record<string, unknown> = {
      content,
      platforms: [{ platform: 'linkedin', accountId: LINKEDIN_ACCOUNT_ID }],
      media: [{ url: presign.publicUrl }],
    };

    if (publishNow) {
      body.publishNow = true;
    }

    if (firstComment) {
      body.platformSpecificData = {
        linkedin: { firstComment },
      };
    }

    const data = await zernioFetch<ZernioPost>('/posts', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return { success: true, data };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn publishPostWithImage error:', msg);
    return { success: false, error: msg };
  }
}

/**
 * List all posts from Zernio.
 */
export async function listPosts(): Promise<ZernioListResponse> {
  try {
    const response = await zernioFetch<{ posts: ZernioPost[]; pagination: unknown }>('/posts');
    return { success: true, data: response.posts || [] };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn listPosts error:', msg);
    return { success: false, error: msg };
  }
}

/**
 * Check LinkedIn account connection health.
 */
export async function getAccountHealth(): Promise<ZernioHealthResponse> {
  try {
    const response = await zernioFetch<{ accounts: Array<Record<string, unknown>> }>(
      '/accounts'
    );
    const account = response.accounts?.find(
      (a: Record<string, unknown>) => a._id === LINKEDIN_ACCOUNT_ID
    );
    if (!account) {
      return { success: false, error: 'LinkedIn account not found in Zernio' };
    }
    return {
      success: true,
      data: {
        platform: 'linkedin',
        accountId: LINKEDIN_ACCOUNT_ID,
        status: account.isActive ? 'connected' : 'disconnected',
        connectedAt: (account.metadata as Record<string, unknown>)?.connectedAt as string | undefined,
        expiresAt: account.tokenExpiresAt as string | undefined,
      },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn getAccountHealth error:', msg);
    return { success: false, error: msg };
  }
}
