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

export type LeadTag = 'general' | 'reel-fitness' | 'reel-nutricion' | 'story-promo';

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
  'general': 1,
  'reel-fitness': 2,
  'reel-nutricion': 3,
  'story-promo': 4,
};
