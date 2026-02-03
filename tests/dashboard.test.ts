import { NextRequest } from 'next/server';

// Mock storage module
jest.mock('@/lib/storage', () => ({
  getLeads: jest.fn(),
  getMetrics: jest.fn(),
}));

import { GET } from '@/app/api/leads/route';
import { getLeads, getMetrics } from '@/lib/storage';

const mockedGetLeads = getLeads as jest.MockedFunction<typeof getLeads>;
const mockedGetMetrics = getMetrics as jest.MockedFunction<typeof getMetrics>;

describe('Leads API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.API_SECRET_KEY = 'test-secret-key';
  });

  describe('GET /api/leads', () => {
    it('returns 401 without API key', async () => {
      const request = new NextRequest('http://localhost/api/leads');

      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it('returns 401 with invalid API key', async () => {
      const request = new NextRequest('http://localhost/api/leads', {
        headers: { 'x-api-key': 'wrong-key' },
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it('returns leads with valid API key', async () => {
      const mockLeads = [
        {
          id: 'lead_1',
          email: 'test1@example.com',
          name: 'Test User 1',
          source: 'instagram',
          tag: 'general' as const,
          status: 'subscribed' as const,
          createdAt: '2024-01-15T10:00:00Z',
          updatedAt: '2024-01-15T10:00:00Z',
        },
        {
          id: 'lead_2',
          email: 'test2@example.com',
          name: 'Test User 2',
          source: 'instagram',
          tag: 'reel-fitness' as const,
          status: 'purchased' as const,
          createdAt: '2024-01-14T10:00:00Z',
          updatedAt: '2024-01-15T12:00:00Z',
        },
      ];
      mockedGetLeads.mockResolvedValue(mockLeads);

      const request = new NextRequest('http://localhost/api/leads', {
        headers: { 'x-api-key': 'test-secret-key' },
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.leads).toHaveLength(2);
      expect(data.count).toBe(2);
    });

    it('includes metrics when requested', async () => {
      mockedGetLeads.mockResolvedValue([]);
      mockedGetMetrics.mockResolvedValue({
        totalLeads: 10,
        newLeads: 2,
        subscribedLeads: 5,
        purchasedLeads: 3,
        errorLeads: 0,
        leadsByTag: {
          general: 4,
          'reel-fitness': 3,
          'reel-nutricion': 2,
          'story-promo': 1,
        },
        leadsBySource: {
          instagram: 8,
          facebook: 2,
        },
      });

      const request = new NextRequest('http://localhost/api/leads?metrics=true', {
        headers: { 'x-api-key': 'test-secret-key' },
      });

      const response = await GET(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.metrics).toBeDefined();
      expect(data.metrics.totalLeads).toBe(10);
    });

    it('filters by status', async () => {
      mockedGetLeads.mockResolvedValue([]);

      const request = new NextRequest('http://localhost/api/leads?status=purchased', {
        headers: { 'x-api-key': 'test-secret-key' },
      });

      await GET(request);

      expect(mockedGetLeads).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'purchased' })
      );
    });

    it('filters by tag', async () => {
      mockedGetLeads.mockResolvedValue([]);

      const request = new NextRequest('http://localhost/api/leads?tag=reel-fitness', {
        headers: { 'x-api-key': 'test-secret-key' },
      });

      await GET(request);

      expect(mockedGetLeads).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'reel-fitness' })
      );
    });

    it('applies pagination', async () => {
      mockedGetLeads.mockResolvedValue([]);

      const request = new NextRequest('http://localhost/api/leads?limit=50&offset=10', {
        headers: { 'x-api-key': 'test-secret-key' },
      });

      await GET(request);

      expect(mockedGetLeads).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50, offset: 10 })
      );
    });
  });
});
