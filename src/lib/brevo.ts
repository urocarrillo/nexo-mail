import * as Brevo from '@getbrevo/brevo';
import { BrevoContact, LeadTag, TAG_TO_LIST_ID, PURCHASERS_LIST_ID, PRODUCT_TO_BUYER_LIST } from './types';

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
  // Determine lead score and lead magnet based on tag
  const isLeadMagnet = tag.startsWith('lead-magnet');
  const leadMagnet = isLeadMagnet ? tag.replace('lead-magnet-', '') : '';

  createContact.attributes = {
    FIRSTNAME: firstName,
    LASTNAME: lastName,
    PHONE: phone || '',
    SOURCE: source || 'instagram',
    TAG: tag,
    HAS_PURCHASED: false,
    LEAD_SCORE: 1,
    LEAD_MAGNET: leadMagnet,
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

// Product ID of the Programa DE — its buyer list is env-driven (created by the
// filtro-cliente backfill, ver PRD-filtro-cliente).
const PROGRAMA_DE_PRODUCT_ID = 3740;

/** ID de la lista "Compradores Programa 3740" (creada por el backfill). */
export function compradores3740ListId(): number | null {
  const raw = process.env.BREVO_LIST_COMPRADORES_3740;
  const id = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(id) ? id : null;
}

export interface PurchaseDetails {
  productos?: string; // texto para el atributo PRODUCTOS (ej: "programa, curso-ep")
  fechaCompra?: string; // ISO o YYYY-MM-DD para FECHA_COMPRA
}

export async function markAsPurchased(
  email: string,
  orderId: string,
  productIds: number[] = [],
  details?: PurchaseDetails
): Promise<AddContactResult> {
  const updateContact = new Brevo.UpdateContact();
  const attributes: Record<string, unknown> = {
    HAS_PURCHASED: true,
    ORDER_ID: orderId,
  };
  if (details?.productos) attributes.PRODUCTOS = details.productos;
  if (details?.fechaCompra) attributes.FECHA_COMPRA = details.fechaCompra;
  updateContact.attributes = attributes;

  // Add to purchasers list (#18) + product-specific buyer lists for cross-sell
  const listIds = [PURCHASERS_LIST_ID];
  for (const productId of productIds) {
    const buyerListId = PRODUCT_TO_BUYER_LIST[productId];
    if (buyerListId) {
      listIds.push(buyerListId);
    }
  }
  // Lista dedicada del programa (env-driven), si la compra incluye el 3740.
  const programaList = compradores3740ListId();
  if (programaList && productIds.includes(PROGRAMA_DE_PRODUCT_ID)) {
    listIds.push(programaList);
  }
  updateContact.listIds = listIds;

  try {
    await apiInstance.updateContact(email, updateContact);
    console.log(`Marked ${email} as purchased (order ${orderId}), added to lists: ${listIds.join(', ')}`);
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

// ─── Helpers de sincronización de compradores (PRD-filtro-cliente) ──
// Usan la REST API cruda (mismo estilo que webhook/typeform) para operaciones
// batch de lista/import que el SDK expone de forma más verbosa.

const BREVO_BASE = 'https://api.brevo.com/v3';

function brevoFetch(path: string, init?: RequestInit): Promise<Response> {
  const apiKey = process.env.BREVO_API_KEY || '';
  return fetch(`${BREVO_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
      ...(init?.headers || {}),
    },
  });
}

/**
 * Busca una lista por nombre; si no existe la crea. Devuelve el ID.
 * folderId configurable con BREVO_LIST_FOLDER_ID (default 1 = carpeta raíz).
 */
export async function createOrGetList(
  name: string
): Promise<{ success: boolean; listId?: number; created?: boolean; error?: string }> {
  // 1. Buscar en las listas existentes (paginado).
  let offset = 0;
  const limit = 50;
  for (let guard = 0; guard < 40; guard++) {
    const res = await brevoFetch(`/contacts/lists?limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      return { success: false, error: `Brevo lists ${res.status}: ${await res.text()}` };
    }
    const data = (await res.json()) as { lists?: Array<{ id: number; name: string }>; count?: number };
    const found = (data.lists || []).find((l) => l.name === name);
    if (found) return { success: true, listId: found.id, created: false };
    if (!data.lists || data.lists.length < limit) break;
    offset += limit;
  }

  // 2. Crear.
  const folderId = parseInt(process.env.BREVO_LIST_FOLDER_ID || '1', 10) || 1;
  const res = await brevoFetch(`/contacts/lists`, {
    method: 'POST',
    body: JSON.stringify({ name, folderId }),
  });
  if (res.status === 201) {
    const data = (await res.json()) as { id: number };
    return { success: true, listId: data.id, created: true };
  }
  return { success: false, error: `Brevo create list ${res.status}: ${await res.text()}` };
}

/** Agrega emails a una lista (batches de 150, tope de la API). */
export async function addContactsToList(
  listId: number,
  emails: string[]
): Promise<{ success: boolean; added: number; error?: string }> {
  let added = 0;
  for (let i = 0; i < emails.length; i += 150) {
    const batch = emails.slice(i, i + 150);
    const res = await brevoFetch(`/contacts/lists/${listId}/contacts/add`, {
      method: 'POST',
      body: JSON.stringify({ emails: batch }),
    });
    // 201/204 ok. La API puede devolver 400 si TODOS ya estaban en la lista.
    if (res.status === 201 || res.status === 204) {
      added += batch.length;
    } else {
      const body = await res.text();
      if (!(res.status === 400 && body.toLowerCase().includes('already'))) {
        return { success: false, added, error: `Brevo add-to-list ${res.status}: ${body}` };
      }
    }
  }
  return { success: true, added };
}

/**
 * Import batch de compradores (crea/actualiza atributos). Usa el endpoint
 * /contacts/import con updateExistingContacts=true.
 */
export async function importBuyers(
  buyers: Array<{ email: string; attributes: Record<string, unknown> }>,
  listIds: number[] = []
): Promise<{ success: boolean; error?: string }> {
  if (buyers.length === 0) return { success: true };
  const body = {
    listIds,
    updateExistingContacts: true,
    emptyContactsAttributes: false,
    jsonBody: buyers.map((b) => ({ email: b.email, attributes: b.attributes })),
  };
  const res = await brevoFetch(`/contacts/import`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  // 200 (sync) o 202 (async processId)
  if (res.status === 200 || res.status === 202) return { success: true };
  return { success: false, error: `Brevo import ${res.status}: ${await res.text()}` };
}

/** Set de emails con HAS_PURCHASED (miembros de la lista de compradores #18). */
export async function getBrevoPurchasedSet(): Promise<Set<string>> {
  const set = new Set<string>();
  let offset = 0;
  const limit = 500;
  for (let guard = 0; guard < 100; guard++) {
    const res = await brevoFetch(
      `/contacts/lists/${PURCHASERS_LIST_ID}/contacts?limit=${limit}&offset=${offset}`
    );
    if (!res.ok) break;
    const data = (await res.json()) as { contacts?: Array<{ email?: string }> };
    const contacts = data.contacts || [];
    for (const c of contacts) {
      if (c.email) set.add(c.email.trim().toLowerCase());
    }
    if (contacts.length < limit) break;
    offset += limit;
  }
  return set;
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
