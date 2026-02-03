import { kv } from '@vercel/kv';
import { Lead, LeadStatus, LeadTag, DashboardMetrics } from './types';

const LEADS_KEY = 'leads';
const LEADS_BY_EMAIL_KEY = 'leads:email';

function generateId(): string {
  return `lead_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export async function saveLead(
  data: Omit<Lead, 'id' | 'createdAt' | 'updatedAt' | 'status'>
): Promise<Lead> {
  const now = new Date().toISOString();
  const lead: Lead = {
    ...data,
    id: generateId(),
    status: 'new',
    createdAt: now,
    updatedAt: now,
  };

  try {
    // Store lead by ID
    await kv.hset(LEADS_KEY, { [lead.id]: JSON.stringify(lead) });

    // Index by email for quick lookup
    await kv.hset(LEADS_BY_EMAIL_KEY, { [lead.email]: lead.id });

    return lead;
  } catch (error) {
    console.error('Storage error (saveLead):', error);
    throw error;
  }
}

export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
  additionalData?: Partial<Lead>
): Promise<Lead | null> {
  try {
    const leadJson = await kv.hget<string>(LEADS_KEY, id);
    if (!leadJson) {
      return null;
    }

    const lead: Lead = typeof leadJson === 'string' ? JSON.parse(leadJson) : leadJson;
    const updatedLead: Lead = {
      ...lead,
      ...additionalData,
      status,
      updatedAt: new Date().toISOString(),
    };

    await kv.hset(LEADS_KEY, { [id]: JSON.stringify(updatedLead) });
    return updatedLead;
  } catch (error) {
    console.error('Storage error (updateLeadStatus):', error);
    throw error;
  }
}

export async function getLeadByEmail(email: string): Promise<Lead | null> {
  try {
    const leadId = await kv.hget<string>(LEADS_BY_EMAIL_KEY, email);
    if (!leadId) {
      return null;
    }

    const leadJson = await kv.hget<string>(LEADS_KEY, leadId);
    if (!leadJson) {
      return null;
    }

    return typeof leadJson === 'string' ? JSON.parse(leadJson) : leadJson;
  } catch (error) {
    console.error('Storage error (getLeadByEmail):', error);
    return null;
  }
}

export async function getLeadById(id: string): Promise<Lead | null> {
  try {
    const leadJson = await kv.hget<string>(LEADS_KEY, id);
    if (!leadJson) {
      return null;
    }

    return typeof leadJson === 'string' ? JSON.parse(leadJson) : leadJson;
  } catch (error) {
    console.error('Storage error (getLeadById):', error);
    return null;
  }
}

export async function getLeads(
  options?: {
    status?: LeadStatus;
    tag?: LeadTag;
    limit?: number;
    offset?: number;
  }
): Promise<Lead[]> {
  try {
    const allLeads = await kv.hgetall<Record<string, string>>(LEADS_KEY);
    if (!allLeads) {
      return [];
    }

    let leads: Lead[] = Object.values(allLeads).map((json) =>
      typeof json === 'string' ? JSON.parse(json) : json
    );

    // Apply filters
    if (options?.status) {
      leads = leads.filter((lead) => lead.status === options.status);
    }
    if (options?.tag) {
      leads = leads.filter((lead) => lead.tag === options.tag);
    }

    // Sort by createdAt descending
    leads.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    return leads.slice(offset, offset + limit);
  } catch (error) {
    console.error('Storage error (getLeads):', error);
    return [];
  }
}

export async function getMetrics(): Promise<DashboardMetrics> {
  try {
    const allLeads = await kv.hgetall<Record<string, string>>(LEADS_KEY);
    const leads: Lead[] = allLeads
      ? Object.values(allLeads).map((json) =>
          typeof json === 'string' ? JSON.parse(json) : json
        )
      : [];

    const metrics: DashboardMetrics = {
      totalLeads: leads.length,
      newLeads: 0,
      subscribedLeads: 0,
      purchasedLeads: 0,
      errorLeads: 0,
      leadsByTag: {
        'general': 0,
        'reel-fitness': 0,
        'reel-nutricion': 0,
        'story-promo': 0,
      },
      leadsBySource: {},
    };

    for (const lead of leads) {
      // Count by status
      switch (lead.status) {
        case 'new':
          metrics.newLeads++;
          break;
        case 'subscribed':
          metrics.subscribedLeads++;
          break;
        case 'purchased':
          metrics.purchasedLeads++;
          break;
        case 'error':
          metrics.errorLeads++;
          break;
      }

      // Count by tag
      if (lead.tag && lead.tag in metrics.leadsByTag) {
        metrics.leadsByTag[lead.tag]++;
      }

      // Count by source
      const source = lead.source || 'unknown';
      metrics.leadsBySource[source] = (metrics.leadsBySource[source] || 0) + 1;
    }

    return metrics;
  } catch (error) {
    console.error('Storage error (getMetrics):', error);
    return {
      totalLeads: 0,
      newLeads: 0,
      subscribedLeads: 0,
      purchasedLeads: 0,
      errorLeads: 0,
      leadsByTag: {
        'general': 0,
        'reel-fitness': 0,
        'reel-nutricion': 0,
        'story-promo': 0,
      },
      leadsBySource: {},
    };
  }
}

export async function markLeadAsPurchased(
  email: string,
  orderId: string
): Promise<Lead | null> {
  const lead = await getLeadByEmail(email);
  if (!lead) {
    return null;
  }

  return updateLeadStatus(lead.id, 'purchased', {
    woocommerceOrderId: orderId,
  });
}
