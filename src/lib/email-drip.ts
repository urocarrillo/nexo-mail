import { kv } from '@vercel/kv';
import * as Brevo from '@getbrevo/brevo';
import { LeadTag } from './types';

// ─── Sequence definitions ───────────────────────────────────────────
// Each step: { templateId, delayDays } where delayDays is from subscription date
interface DripStep {
  templateId: number;
  delayDays: number;
  subject: string; // for logging/debugging
}

interface DripSequence {
  steps: DripStep[];
}

// Template IDs from Brevo (created via scripts/create-brevo-templates.py)
const SEQUENCES: Partial<Record<LeadTag, DripSequence>> = {
  'lead-magnet-ep': {
    steps: [
      { templateId: 88, delayDays: 0, subject: 'EP Email 1: Entrega PDF' },
      { templateId: 89, delayDays: 3, subject: 'EP Email 2: Valor + ciclo' },
      { templateId: 90, delayDays: 7, subject: 'EP Email 3: Oferta' },
    ],
  },
  'lead-magnet-preservativo': {
    steps: [
      { templateId: 91, delayDays: 0, subject: 'Preservativo Email 1: PDF' },
      { templateId: 92, delayDays: 3, subject: 'Preservativo Email 2: Insight' },
      { templateId: 93, delayDays: 7, subject: 'Preservativo Email 3: Curso' },
    ],
  },
  'waitlist-programa': {
    steps: [
      { templateId: 94, delayDays: 0, subject: 'Waitlist Email 1: Confirmación' },
      { templateId: 95, delayDays: 4, subject: 'Waitlist Email 2: Historia' },
      { templateId: 96, delayDays: 10, subject: 'Waitlist Email 3: Recursos' },
    ],
  },
  // lead-magnet-5h: handled by existing Brevo automation #27
  // general: no drip sequence
};

// ─── Scheduled email entry ──────────────────────────────────────────
interface ScheduledEmail {
  id: string;
  email: string;
  name?: string;
  tag: LeadTag;
  stepIndex: number;
  templateId: number;
  subject: string;
  sendAt: string; // ISO date
  status: 'pending' | 'sent' | 'failed';
  createdAt: string;
  sentAt?: string;
  error?: string;
}

const DRIP_QUEUE_KEY = 'drip:queue';
const DRIP_SENT_KEY = 'drip:sent';

// ─── Brevo transactional email sender ───────────────────────────────
const transacApi = new Brevo.TransactionalEmailsApi();
transacApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY || ''
);

async function sendTemplate(
  templateId: number,
  email: string,
  name?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const sendEmail = new Brevo.SendSmtpEmail();
    sendEmail.templateId = templateId;
    sendEmail.to = [{ email, name: name || undefined }];

    const result = await transacApi.sendTransacEmail(sendEmail);
    return { success: true, messageId: result.body?.messageId };
  } catch (error: unknown) {
    const apiError = error as { response?: { body?: { message?: string } }; message?: string };
    console.error('Brevo send error:', apiError.response?.body || apiError.message);
    return {
      success: false,
      error: apiError.response?.body?.message || apiError.message || 'Unknown error',
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Start a drip sequence for a new subscriber.
 * Sends Email 1 immediately, schedules the rest.
 */
export async function startDripSequence(
  email: string,
  tag: LeadTag,
  name?: string
): Promise<{ started: boolean; emailsSent: number; emailsScheduled: number }> {
  const sequence = SEQUENCES[tag];
  if (!sequence) {
    return { started: false, emailsSent: 0, emailsScheduled: 0 };
  }

  // Check if this email already has a drip for this tag (avoid duplicates)
  const existingKey = `${email}:${tag}`;
  const existing = await kv.hget<string>(DRIP_SENT_KEY, existingKey);
  if (existing) {
    console.log(`Drip already started for ${email} / ${tag}, skipping`);
    return { started: false, emailsSent: 0, emailsScheduled: 0 };
  }

  const now = new Date();
  let emailsSent = 0;
  let emailsScheduled = 0;

  // FIRST: schedule all future emails (so they're queued even if immediate send fails)
  for (let i = 0; i < sequence.steps.length; i++) {
    const step = sequence.steps[i];
    if (step.delayDays === 0) continue; // handle immediate separately below

    try {
      const sendAt = new Date(now.getTime() + step.delayDays * 24 * 60 * 60 * 1000);
      const scheduled: ScheduledEmail = {
        id: `drip_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        email,
        name,
        tag,
        stepIndex: i,
        templateId: step.templateId,
        subject: step.subject,
        sendAt: sendAt.toISOString(),
        status: 'pending',
        createdAt: now.toISOString(),
      };

      await kv.hset(DRIP_QUEUE_KEY, { [scheduled.id]: JSON.stringify(scheduled) });
      emailsScheduled++;
      console.log(`Drip scheduled: ${step.subject} → ${email} at ${sendAt.toISOString()}`);
    } catch (err) {
      console.error(`Drip schedule error for step ${i}:`, err);
    }
  }

  // THEN: send immediate emails (Email 1)
  for (const step of sequence.steps) {
    if (step.delayDays !== 0) continue;

    try {
      const result = await sendTemplate(step.templateId, email, name);
      if (result.success) {
        emailsSent++;
        console.log(`Drip sent: ${step.subject} → ${email}`);
      } else {
        console.error(`Drip send failed: ${step.subject} → ${email}: ${result.error}`);
      }
    } catch (err) {
      console.error(`Drip send error: ${step.subject} → ${email}:`, err);
    }
  }

  // Mark as started to prevent duplicates
  try {
    await kv.hset(DRIP_SENT_KEY, { [existingKey]: now.toISOString() });
  } catch (err) {
    console.error('Drip mark-started error:', err);
  }

  return { started: true, emailsSent, emailsScheduled };
}

/**
 * Process the drip queue — called by Vercel Cron daily.
 * Sends all emails that are due.
 */
export async function processDripQueue(): Promise<{
  processed: number;
  sent: number;
  failed: number;
  remaining: number;
}> {
  const now = new Date();
  const allEntries = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);

  if (!allEntries) {
    return { processed: 0, sent: 0, failed: 0, remaining: 0 };
  }

  let processed = 0;
  let sent = 0;
  let failed = 0;
  let remaining = 0;

  for (const [id, json] of Object.entries(allEntries)) {
    const entry: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;

    if (entry.status !== 'pending') {
      continue;
    }

    const sendAt = new Date(entry.sendAt);
    if (sendAt > now) {
      remaining++;
      continue;
    }

    // Time to send
    processed++;
    const result = await sendTemplate(entry.templateId, entry.email, entry.name);

    if (result.success) {
      sent++;
      entry.status = 'sent';
      entry.sentAt = now.toISOString();
      console.log(`Cron sent: ${entry.subject} → ${entry.email}`);
    } else {
      failed++;
      entry.status = 'failed';
      entry.error = result.error;
      console.error(`Cron failed: ${entry.subject} → ${entry.email}: ${result.error}`);
    }

    // Update entry (mark as sent/failed so it's not retried)
    await kv.hset(DRIP_QUEUE_KEY, { [id]: JSON.stringify(entry) });
  }

  return { processed, sent, failed, remaining };
}

/**
 * Get drip queue stats for dashboard.
 */
export async function getDripStats(): Promise<{
  pending: number;
  sent: number;
  failed: number;
  byTag: Record<string, number>;
}> {
  const allEntries = await kv.hgetall<Record<string, string>>(DRIP_QUEUE_KEY);
  const stats = { pending: 0, sent: 0, failed: 0, byTag: {} as Record<string, number> };

  if (!allEntries) return stats;

  for (const json of Object.values(allEntries)) {
    const entry: ScheduledEmail = typeof json === 'string' ? JSON.parse(json) : json;
    if (entry.status === 'pending') stats.pending++;
    else if (entry.status === 'sent') stats.sent++;
    else if (entry.status === 'failed') stats.failed++;

    stats.byTag[entry.tag] = (stats.byTag[entry.tag] || 0) + 1;
  }

  return stats;
}
