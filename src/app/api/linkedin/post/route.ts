import { NextRequest, NextResponse } from 'next/server';
import { publishPost, publishPostWithImage } from '@/lib/linkedin';

function validateApiKey(request: NextRequest): boolean {
  const apiKey = request.headers.get('x-api-key');
  return apiKey === process.env.API_SECRET_KEY;
}

interface PostRequestBody {
  content: string;
  publishNow?: boolean;
  scheduledFor?: string;
  imageUrl?: string;
  firstComment?: string;
}

function validatePayload(data: unknown): { valid: boolean; error?: string; payload?: PostRequestBody } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid payload' };
  }

  const body = data as Record<string, unknown>;

  if (!body.content || typeof body.content !== 'string') {
    return { valid: false, error: 'content is required and must be a string' };
  }

  if (body.content.trim().length === 0) {
    return { valid: false, error: 'content cannot be empty' };
  }

  if (body.scheduledFor && typeof body.scheduledFor !== 'string') {
    return { valid: false, error: 'scheduledFor must be an ISO date string' };
  }

  if (body.imageUrl && typeof body.imageUrl !== 'string') {
    return { valid: false, error: 'imageUrl must be a string' };
  }

  if (body.firstComment && typeof body.firstComment !== 'string') {
    return { valid: false, error: 'firstComment must be a string' };
  }

  return {
    valid: true,
    payload: {
      content: body.content.trim(),
      publishNow: body.publishNow !== false && !body.scheduledFor,
      scheduledFor: body.scheduledFor as string | undefined,
      imageUrl: body.imageUrl as string | undefined,
      firstComment: body.firstComment as string | undefined,
    },
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Validate API key
  if (!validateApiKey(request)) {
    return NextResponse.json(
      { success: false, error: 'Invalid or missing API key' },
      { status: 401 }
    );
  }

  // Check Zernio API key is configured
  if (!process.env.ZERNIO_API_KEY) {
    return NextResponse.json(
      { success: false, error: 'ZERNIO_API_KEY not configured' },
      { status: 500 }
    );
  }

  // Parse and validate payload
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Could not parse request body' },
      { status: 400 }
    );
  }

  const validation = validatePayload(body);
  if (!validation.valid || !validation.payload) {
    return NextResponse.json(
      { success: false, error: validation.error },
      { status: 400 }
    );
  }

  const { content, publishNow, scheduledFor, imageUrl, firstComment } = validation.payload;

  try {
    let result;

    if (imageUrl) {
      result = await publishPostWithImage(content, imageUrl, publishNow, firstComment);
    } else {
      result = await publishPost(content, publishNow, scheduledFor, firstComment);
    }

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 502 }
      );
    }

    const action = publishNow ? 'published' : 'scheduled';
    console.log(`LinkedIn post ${action}: ${content.slice(0, 80)}...`);

    return NextResponse.json({
      success: true,
      action,
      post: result.data,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('LinkedIn post route error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
