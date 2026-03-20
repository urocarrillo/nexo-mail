import { NextRequest, NextResponse } from 'next/server';
import {
  getAffiliates,
  getAffiliate,
  addAffiliate,
  getSales,
  generateCode,
  getAffiliateLink,
} from '@/lib/sheets-affiliates';
import { sendAffiliateWelcomeEmail } from '@/lib/email-affiliate';

function checkAuth(request: NextRequest): boolean {
  const apiKey = request.headers.get('X-API-Key');
  return apiKey === process.env.API_SECRET_KEY;
}

// GET /api/affiliates — List all affiliates + optionally sales
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!checkAuth(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const includeSales = request.nextUrl.searchParams.get('sales') === 'true';
    const affiliates = await getAffiliates();
    const result: Record<string, unknown> = { success: true, affiliates };

    if (includeSales) {
      const sales = await getSales();
      result.sales = sales;
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching affiliates:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST /api/affiliates — Create new affiliate
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkAuth(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { nombre, email, whatsapp, alias, cbu, comision_pct, destino } = body;

    if (!nombre || !email) {
      return NextResponse.json(
        { success: false, error: 'nombre and email are required' },
        { status: 400 }
      );
    }

    // Generate unique code
    let codigo = generateCode();
    let existing = await getAffiliate(codigo);
    let attempts = 0;
    while (existing && attempts < 10) {
      codigo = generateCode();
      existing = await getAffiliate(codigo);
      attempts++;
    }

    if (existing) {
      return NextResponse.json(
        { success: false, error: 'Could not generate unique code, try again' },
        { status: 500 }
      );
    }

    const affiliate = await addAffiliate({
      codigo,
      nombre,
      email,
      whatsapp: whatsapp || '',
      alias: alias || '',
      cbu: cbu || '',
      comision_pct: comision_pct || 20,
      destino: destino || 'recuperatuereccion',
    });

    const link = getAffiliateLink(affiliate);

    // Send welcome email
    try {
      await sendAffiliateWelcomeEmail({
        email: affiliate.email,
        nombre: affiliate.nombre,
        link,
        comision_pct: affiliate.comision_pct,
      });
    } catch (emailErr) {
      console.error('Failed to send welcome email:', emailErr);
      // Don't fail the creation if email fails
    }

    return NextResponse.json({
      success: true,
      affiliate,
      link,
      message: `Affiliate created. Welcome email sent to ${affiliate.email}`,
    });
  } catch (error) {
    console.error('Error creating affiliate:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
