import * as Brevo from '@getbrevo/brevo';
import { BrevoContact, LeadTag, TAG_TO_LIST_ID } from './types';

const apiInstance = new Brevo.ContactsApi();
apiInstance.setApiKey(
  Brevo.ContactsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

export interface AddContactParams {
  email: string;
  name?: string;
  phone?: string;
  source?: string;
  tag?: LeadTag;
}

export interface AddContactResult {
  success: boolean;
  contactId?: number;
  error?: string;
}

export async function addContactToBrevo(
  params: AddContactParams
): Promise<AddContactResult> {
  const { email, name, phone, source, tag = 'general' } = params;

  const listId = TAG_TO_LIST_ID[tag];

  const nameParts = name?.split(' ') || [];
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const createContact = new Brevo.CreateContact();
  createContact.email = email;
  createContact.attributes = {
    FIRSTNAME: firstName,
    LASTNAME: lastName,
    PHONE: phone || '',
    SOURCE: source || 'instagram',
    TAG: tag,
    HAS_PURCHASED: false,
  };
  createContact.listIds = [listId];
  createContact.updateEnabled = true;

  try {
    const response = await apiInstance.createContact(createContact);
    return {
      success: true,
      contactId: response.body?.id,
    };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };

    // If contact already exists and updateEnabled is true, it's still a success
    if (apiError.response?.body?.message?.includes('Contact already exist')) {
      return {
        success: true,
      };
    }

    console.error('Brevo API Error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

export async function markAsPurchased(
  email: string,
  orderId: string
): Promise<AddContactResult> {
  const updateContact = new Brevo.UpdateContact();
  updateContact.attributes = {
    HAS_PURCHASED: true,
    ORDER_ID: orderId,
  };

  try {
    await apiInstance.updateContact(email, updateContact);
    return { success: true };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };
    console.error('Brevo API Error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

export async function getContact(
  email: string
): Promise<{ success: boolean; contact?: BrevoContact; error?: string }> {
  try {
    const response = await apiInstance.getContactInfo(email);
    const contact = response.body;

    return {
      success: true,
      contact: {
        email: contact.email || email,
        attributes: contact.attributes as BrevoContact['attributes'],
        listIds: contact.listIds || [],
      },
    };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string }; statusCode?: number }; message?: string };

    if (apiError.response?.statusCode === 404) {
      return {
        success: false,
        error: 'Contact not found',
      };
    }

    console.error('Brevo API Error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

export async function testConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const accountApi = new Brevo.AccountApi();
    accountApi.setApiKey(
      Brevo.AccountApiApiKeys.apiKey,
      process.env.BREVO_API_KEY || ''
    );
    await accountApi.getAccount();
    return { success: true };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Invalid API key',
    };
  }
}
