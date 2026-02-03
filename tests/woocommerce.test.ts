import { NextRequest } from 'next/server';
import crypto from 'crypto';

// Mock the modules
jest.mock('@/lib/brevo', () => ({
  markAsPurchased: jest.fn(),
}));

jest.mock('@/lib/storage', () => ({
  markLeadAsPurchased: jest.fn(),
}));

import { GET, POST, HEAD } from '@/app/api/webhook/woocommerce/route';
import { markAsPurchased } from '@/lib/brevo';
import { markLeadAsPurchased } from '@/lib/storage';

const mockedMarkAsPurchased = markAsPurchased as jest.MockedFunction<typeof markAsPurchased>;
const mockedMarkLeadAsPurchased = markLeadAsPurchased as jest.MockedFunction<typeof markLeadAsPurchased>;

function generateSignature(payload: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64');
}

const sampleOrder = {
  id: 12345,
  status: 'completed',
  billing: {
    email: 'customer@example.com',
    first_name: 'John',
    last_name: 'Doe',
    phone: '+1234567890',
  },
  line_items: [
    { product_id: 1, name: 'Product 1', quantity: 1 },
  ],
  total: '99.99',
  currency: 'USD',
  date_created: '2024-01-15T10:30:00',
};

describe('WooCommerce Webhook API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.WOOCOMMERCE_WEBHOOK_SECRET = 'test-woo-secret';
  });

  describe('HEAD /api/webhook/woocommerce', () => {
    it('returns 200 for webhook verification', async () => {
      const response = await HEAD();
      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/webhook/woocommerce', () => {
    it('returns active status', async () => {
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('active');
    });
  });

  describe('POST /api/webhook/woocommerce', () => {
    it('returns 401 without signature', async () => {
      const payload = JSON.stringify(sampleOrder);
      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid signature', async () => {
      const payload = JSON.stringify(sampleOrder);
      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        headers: {
          'x-wc-webhook-signature': 'invalid-signature',
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('skips non-completed orders', async () => {
      const order = { ...sampleOrder, status: 'pending' };
      const payload = JSON.stringify(order);
      const signature = generateSignature(payload, 'test-woo-secret');

      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        headers: {
          'x-wc-webhook-signature': signature,
        },
        body: payload,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('pending');
      expect(mockedMarkAsPurchased).not.toHaveBeenCalled();
    });

    it('processes completed order successfully', async () => {
      mockedMarkAsPurchased.mockResolvedValue({ success: true });
      mockedMarkLeadAsPurchased.mockResolvedValue(null);

      const payload = JSON.stringify(sampleOrder);
      const signature = generateSignature(payload, 'test-woo-secret');

      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        headers: {
          'x-wc-webhook-signature': signature,
        },
        body: payload,
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('12345');
      expect(mockedMarkAsPurchased).toHaveBeenCalledWith(
        'customer@example.com',
        '12345'
      );
      expect(mockedMarkLeadAsPurchased).toHaveBeenCalledWith(
        'customer@example.com',
        '12345'
      );
    });

    it('handles Brevo failure gracefully', async () => {
      mockedMarkAsPurchased.mockResolvedValue({
        success: false,
        error: 'Contact not found',
      });
      mockedMarkLeadAsPurchased.mockResolvedValue(null);

      const payload = JSON.stringify(sampleOrder);
      const signature = generateSignature(payload, 'test-woo-secret');

      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        headers: {
          'x-wc-webhook-signature': signature,
        },
        body: payload,
      });

      const response = await POST(request);
      const data = await response.json();

      // Should still return success since the order was processed
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('warning');
    });

    it('returns 400 for invalid order data', async () => {
      const invalidOrder = { id: 'not-a-number' };
      const payload = JSON.stringify(invalidOrder);
      const signature = generateSignature(payload, 'test-woo-secret');

      const request = new NextRequest('http://localhost/api/webhook/woocommerce', {
        method: 'POST',
        headers: {
          'x-wc-webhook-signature': signature,
        },
        body: payload,
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });
});
