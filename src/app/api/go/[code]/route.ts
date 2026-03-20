import { NextRequest, NextResponse } from 'next/server';
import { getAffiliate } from '@/lib/sheets-affiliates';

// GET /api/go/[code] — Public redirect for affiliate links
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
): Promise<NextResponse> {
  const { code } = await params;
  const cleanCode = code.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!cleanCode) {
    return NextResponse.redirect('https://urologia.ar/recuperatuereccion/', 302);
  }

  try {
    const affiliate = await getAffiliate(cleanCode);

    if (affiliate) {
      const destino = affiliate.destino || 'recuperatuereccion';
      if (destino === 'control-eyaculacion-precoz') {
        return NextResponse.redirect(
          `https://urologia.ar/cursos/control-eyaculacion-precoz/?ref=${cleanCode}`,
          302
        );
      }
      return NextResponse.redirect(
        `https://urologia.ar/recuperatuereccion/?ref=${cleanCode}`,
        302
      );
    }

    // Unknown code — redirect to default landing
    return NextResponse.redirect(
      `https://urologia.ar/recuperatuereccion/?ref=${cleanCode}`,
      302
    );
  } catch (error) {
    console.error('Affiliate redirect error:', error);
    return NextResponse.redirect('https://urologia.ar/recuperatuereccion/', 302);
  }
}
