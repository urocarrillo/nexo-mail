import crypto from 'crypto';

const WC_BASE_URL = 'https://urologia.ar/wp-json/wc/v3';
const WP_USER = process.env.WP_USER || '';
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD || '';

// Products eligible for post-consultation discount
const ELIGIBLE_PRODUCT_IDS = [3208, 1043]; // EP, Preservativo

interface WcCoupon {
  id: number;
  code: string;
  amount: string;
  discount_type: string;
  date_expires: string | null;
  usage_count: number;
  usage_limit: number | null;
  product_ids: number[];
  description: string;
}

function generateCouponCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(crypto.randomInt(chars.length));
  }
  return `PAC-${code}`;
}

async function wcFetch(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${WC_BASE_URL}${endpoint}`;
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      ...options.headers,
    },
  });
}

/**
 * Create a unique WooCommerce coupon for a post-consultation patient.
 * 30% off, single use, expires in 24 hours, only for EP + Preservativo courses.
 */
export async function createPatientCoupon(params: {
  patientName: string;
  patientEmail: string;
}): Promise<{ success: boolean; code?: string; error?: string }> {
  const { patientName, patientEmail } = params;
  const code = generateCouponCode();

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const body = {
    code,
    discount_type: 'percent',
    amount: '30',
    individual_use: true,
    usage_limit: 1,
    usage_limit_per_user: 1,
    date_expires: expiresAt.toISOString(),
    product_ids: ELIGIBLE_PRODUCT_IDS,
    description: `Post-consulta ${patientName} (${patientEmail}) — ${new Date().toISOString().split('T')[0]}`,
    meta_data: [
      { key: '_patient_email', value: patientEmail },
      { key: '_source', value: 'calendly-post-consultation' },
    ],
  };

  try {
    const response = await wcFetch('/coupons', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('WooCommerce coupon creation failed:', errorData);
      return {
        success: false,
        error: errorData.message || `HTTP ${response.status}`,
      };
    }

    const coupon = await response.json();
    console.log(`Coupon created: ${code} for ${patientEmail} (WC ID: ${coupon.id})`);
    return { success: true, code };
  } catch (error) {
    console.error('WooCommerce coupon error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Delete all expired PAC-* coupons from WooCommerce.
 * Called by the cleanup cron job.
 */
export async function cleanupExpiredCoupons(): Promise<{
  checked: number;
  deleted: number;
  errors: number;
}> {
  let checked = 0;
  let deleted = 0;
  let errors = 0;
  let page = 1;
  const now = new Date();

  // Paginate through all PAC- coupons
  while (true) {
    const response = await wcFetch(
      `/coupons?search=PAC-&per_page=100&page=${page}`
    );

    if (!response.ok) {
      console.error(`Failed to fetch coupons page ${page}:`, response.status);
      break;
    }

    const coupons: WcCoupon[] = await response.json();
    if (coupons.length === 0) break;

    for (const coupon of coupons) {
      checked++;

      // Skip coupons without expiration
      if (!coupon.date_expires) continue;

      const expiresAt = new Date(coupon.date_expires);
      if (expiresAt >= now) continue;

      // Expired — delete it
      try {
        const delResponse = await wcFetch(`/coupons/${coupon.id}?force=true`, {
          method: 'DELETE',
        });

        if (delResponse.ok) {
          deleted++;
          console.log(`Deleted expired coupon: ${coupon.code} (ID ${coupon.id})`);
        } else {
          errors++;
          console.error(`Failed to delete coupon ${coupon.code}:`, delResponse.status);
        }
      } catch (err) {
        errors++;
        console.error(`Error deleting coupon ${coupon.code}:`, err);
      }
    }

    page++;
  }

  return { checked, deleted, errors };
}
