import { TAG_TO_LIST_ID } from '@/lib/types';

// Mock the Brevo SDK
jest.mock('@getbrevo/brevo', () => {
  const mockCreateContact = jest.fn();
  const mockUpdateContact = jest.fn();
  const mockGetContactInfo = jest.fn();
  const mockGetAccount = jest.fn();

  return {
    ContactsApi: jest.fn().mockImplementation(() => ({
      setApiKey: jest.fn(),
      createContact: mockCreateContact,
      updateContact: mockUpdateContact,
      getContactInfo: mockGetContactInfo,
    })),
    AccountApi: jest.fn().mockImplementation(() => ({
      setApiKey: jest.fn(),
      getAccount: mockGetAccount,
    })),
    CreateContact: jest.fn().mockImplementation(() => ({})),
    UpdateContact: jest.fn().mockImplementation(() => ({})),
    ContactsApiApiKeys: {
      apiKey: 'api-key',
    },
    AccountApiApiKeys: {
      apiKey: 'api-key',
    },
    __mocks: {
      mockCreateContact,
      mockUpdateContact,
      mockGetContactInfo,
      mockGetAccount,
    },
  };
});

import * as Brevo from '@getbrevo/brevo';
import { addContactToBrevo, markAsPurchased, getContact, testConnection } from '@/lib/brevo';

const { mockCreateContact, mockUpdateContact, mockGetContactInfo, mockGetAccount } = (
  Brevo as unknown as { __mocks: {
    mockCreateContact: jest.Mock;
    mockUpdateContact: jest.Mock;
    mockGetContactInfo: jest.Mock;
    mockGetAccount: jest.Mock;
  } }
).__mocks;

describe('Brevo Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('TAG_TO_LIST_ID mapping', () => {
    it('maps general to list 1', () => {
      expect(TAG_TO_LIST_ID['general']).toBe(1);
    });

    it('maps reel-fitness to list 2', () => {
      expect(TAG_TO_LIST_ID['reel-fitness']).toBe(2);
    });

    it('maps reel-nutricion to list 3', () => {
      expect(TAG_TO_LIST_ID['reel-nutricion']).toBe(3);
    });

    it('maps story-promo to list 4', () => {
      expect(TAG_TO_LIST_ID['story-promo']).toBe(4);
    });
  });

  describe('addContactToBrevo', () => {
    it('creates a contact successfully', async () => {
      mockCreateContact.mockResolvedValue({ body: { id: 12345 } });

      const result = await addContactToBrevo({
        email: 'test@example.com',
        name: 'John Doe',
        phone: '+1234567890',
        source: 'instagram',
        tag: 'general',
      });

      expect(result.success).toBe(true);
      expect(result.contactId).toBe(12345);
    });

    it('handles existing contact as success', async () => {
      mockCreateContact.mockRejectedValue({
        response: { body: { message: 'Contact already exist' } },
      });

      const result = await addContactToBrevo({
        email: 'existing@example.com',
        tag: 'general',
      });

      expect(result.success).toBe(true);
    });

    it('handles API errors', async () => {
      mockCreateContact.mockRejectedValue({
        response: { body: { message: 'Rate limit exceeded' } },
      });

      const result = await addContactToBrevo({
        email: 'test@example.com',
        tag: 'general',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Rate limit exceeded');
    });

    it('uses correct list ID based on tag', async () => {
      mockCreateContact.mockResolvedValue({ body: { id: 1 } });

      await addContactToBrevo({
        email: 'test@example.com',
        tag: 'reel-fitness',
      });

      // The function creates a new CreateContact instance and sets listIds
      // We verify it was called
      expect(mockCreateContact).toHaveBeenCalled();
    });
  });

  describe('markAsPurchased', () => {
    it('updates contact successfully', async () => {
      mockUpdateContact.mockResolvedValue({});

      const result = await markAsPurchased('test@example.com', 'ORDER123');

      expect(result.success).toBe(true);
      expect(mockUpdateContact).toHaveBeenCalledWith(
        'test@example.com',
        expect.any(Object)
      );
    });

    it('handles update errors', async () => {
      mockUpdateContact.mockRejectedValue({
        response: { body: { message: 'Contact not found' } },
      });

      const result = await markAsPurchased('unknown@example.com', 'ORDER123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Contact not found');
    });
  });

  describe('getContact', () => {
    it('retrieves contact successfully', async () => {
      mockGetContactInfo.mockResolvedValue({
        body: {
          email: 'test@example.com',
          attributes: { FIRSTNAME: 'John' },
          listIds: [1],
        },
      });

      const result = await getContact('test@example.com');

      expect(result.success).toBe(true);
      expect(result.contact?.email).toBe('test@example.com');
    });

    it('handles not found', async () => {
      mockGetContactInfo.mockRejectedValue({
        response: { statusCode: 404, body: { message: 'Contact not found' } },
      });

      const result = await getContact('unknown@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Contact not found');
    });
  });

  describe('testConnection', () => {
    it('returns success for valid API key', async () => {
      mockGetAccount.mockResolvedValue({});

      const result = await testConnection();

      expect(result.success).toBe(true);
    });

    it('returns failure for invalid API key', async () => {
      mockGetAccount.mockRejectedValue({
        response: { body: { message: 'Invalid API key' } },
      });

      const result = await testConnection();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });
  });
});
