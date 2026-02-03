import { NextRequest } from 'next/server';

// Mock the modules before importing the route
jest.mock('@/lib/brevo', () => ({
  addContactToBrevo: jest.fn(),
}));

jest.mock('@/lib/storage', () => ({
  saveLead: jest.fn(),
  updateLeadStatus: jest.fn(),
  getLeadByEmail: jest.fn(),
}));

import { GET, POST } from '@/app/api/webhook/sheet/route';
import { addContactToBrevo } from '@/lib/brevo';
import { saveLead, updateLeadStatus, getLeadByEmail } from '@/lib/storage';

const mockedAddContactToBrevo = addContactToBrevo as jest.MockedFunction<typeof addContactToBrevo>;
const mockedSaveLead = saveLead as jest.MockedFunction<typeof saveLead>;
const mockedUpdateLeadStatus = updateLeadStatus as jest.MockedFunction<typeof updateLeadStatus>;
const mockedGetLeadByEmail = getLeadByEmail as jest.MockedFunction<typeof getLeadByEmail>;

describe('Sheet Webhook API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_SECRET_KEY = 'test-secret-key';
  });

  describe('GET /api/webhook/sheet', () => {
    it('returns active status', async () => {
      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain('active');
    });
  });

  describe('POST /api/webhook/sheet', () => {
    it('returns 401 without API key', async () => {
      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid API key', async () => {
      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        headers: { 'x-api-key': 'wrong-key' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('returns 400 for invalid email', async () => {
      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        headers: { 'x-api-key': 'test-secret-key' },
        body: JSON.stringify({ email: 'invalid-email' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('email');
    });

    it('returns 400 for invalid tag', async () => {
      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        headers: { 'x-api-key': 'test-secret-key' },
        body: JSON.stringify({ email: 'test@example.com', tag: 'invalid-tag' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('tag');
    });

    it('processes valid lead successfully', async () => {
      mockedGetLeadByEmail.mockResolvedValue(null);
      mockedSaveLead.mockResolvedValue({
        id: 'lead_123',
        email: 'test@example.com',
        name: 'Test User',
        source: 'instagram',
        tag: 'general',
        status: 'new',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockedAddContactToBrevo.mockResolvedValue({
        success: true,
        contactId: 12345,
      });
      mockedUpdateLeadStatus.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        headers: { 'x-api-key': 'test-secret-key' },
        body: JSON.stringify({
          email: 'test@example.com',
          name: 'Test User',
          tag: 'reel-fitness',
        }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.leadId).toBe('lead_123');
      expect(mockedAddContactToBrevo).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'Test User',
        phone: undefined,
        source: 'instagram',
        tag: 'reel-fitness',
      });
    });

    it('handles Brevo failure', async () => {
      mockedGetLeadByEmail.mockResolvedValue(null);
      mockedSaveLead.mockResolvedValue({
        id: 'lead_123',
        email: 'test@example.com',
        source: 'instagram',
        tag: 'general',
        status: 'new',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockedAddContactToBrevo.mockResolvedValue({
        success: false,
        error: 'API Error',
      });
      mockedUpdateLeadStatus.mockResolvedValue(null);

      const request = new NextRequest('http://localhost/api/webhook/sheet', {
        method: 'POST',
        headers: { 'x-api-key': 'test-secret-key' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.success).toBe(false);
      expect(data.error).toBe('API Error');
    });
  });
});
