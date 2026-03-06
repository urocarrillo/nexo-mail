export interface Lead {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  source: string;
  tag: LeadTag;
  status: LeadStatus;
  brevoContactId?: number;
  woocommerceOrderId?: string;
  createdAt: string;
  updatedAt: string;
}

export type LeadTag = 'general' | 'programa-de' | 'eyaculacion-precoz' | 'youtube' | 'lead-magnet-5h' | 'lead-magnet-ep' | 'lead-magnet-preservativo' | 'waitlist-programa' | 'blog-suscriptor';

export type LeadStatus = 'new' | 'subscribed' | 'purchased' | 'error';

export interface WebhookPayload {
  email: string;
  name?: string;
  phone?: string;
  source?: string;
  tag?: LeadTag;
}

export interface WebhookResponse {
  success: boolean;
  message: string;
  leadId?: string;
  error?: string;
}

export interface WooCommerceOrder {
  id: number;
  status: string;
  billing: {
    email: string;
    first_name: string;
    last_name: string;
    phone?: string;
  };
  line_items: Array<{
    product_id: number;
    name: string;
    quantity: number;
  }>;
  total: string;
  currency: string;
  date_created: string;
}

export interface BrevoContact {
  email: string;
  attributes?: {
    FIRSTNAME?: string;
    LASTNAME?: string;
    PHONE?: string;
    SOURCE?: string;
    TAG?: string;
    HAS_PURCHASED?: boolean;
    ORDER_ID?: string;
    LEAD_SCORE?: number;
    LEAD_MAGNET?: string;
  };
  listIds: number[];
  updateEnabled?: boolean;
}

export interface DashboardMetrics {
  totalLeads: number;
  newLeads: number;
  subscribedLeads: number;
  purchasedLeads: number;
  errorLeads: number;
  leadsByTag: Record<LeadTag, number>;
  leadsBySource: Record<string, number>;
}

// Tag to Brevo List ID mapping
export const TAG_TO_LIST_ID: Record<LeadTag, number> = {
  'general': 16,           // Leads WooCommerce
  'programa-de': 9,        // DISFUNCIÓN ERÉCTIL
  'eyaculacion-precoz': 20, // EYACULACIÓN Precoz
  'youtube': 14,           // YOUTUBE
  'lead-magnet-5h': 25,    // Lead Magnet 5 Herramientas
  'lead-magnet-ep': 26,    // Lead Magnet - 3 Ejercicios EP
  'lead-magnet-preservativo': 27, // Lead Magnet - Erección y Preservativo
  'waitlist-programa': 28, // Waitlist - Programa Ansiedad de Desempeño
  'blog-suscriptor': 29,  // Suscriptores Blog (RSS newsletter)
};

// List ID for customers who completed a purchase
export const PURCHASERS_LIST_ID = 18; // WooCommerce

// Product ID to buyer-specific Brevo list (for cross-sell automations)
export const PRODUCT_TO_BUYER_LIST: Record<number, number> = {
  1043: 30, // Curso Preservativo → Compradores Preservativo
  3208: 31, // Curso EP → Compradores EP
};
