/**
 * Script to create a Calendly webhook subscription.
 *
 * PREREQUISITES:
 * 1. Generate a Personal Access Token at https://calendly.com/integrations/api_webhooks
 * 2. Set CALENDLY_TOKEN env var
 *
 * Run: CALENDLY_TOKEN=xxx npx tsx scripts/setup-calendly-webhook.ts
 */

const CALENDLY_TOKEN = process.env.CALENDLY_TOKEN;
const NEXO_MAIL_URL = 'https://nexo-mail.vercel.app'; // production URL
const WEBHOOK_URL = `${NEXO_MAIL_URL}/api/webhook/calendly`;

if (!CALENDLY_TOKEN) {
  console.error('❌ Missing CALENDLY_TOKEN env var');
  console.log('\nTo get your token:');
  console.log('1. Go to https://calendly.com/integrations/api_webhooks');
  console.log('2. Generate a Personal Access Token');
  console.log('3. Run: CALENDLY_TOKEN=your_token npx tsx scripts/setup-calendly-webhook.ts');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${CALENDLY_TOKEN}`,
};

async function getCurrentUser(): Promise<string> {
  const response = await fetch('https://api.calendly.com/users/me', { headers });
  if (!response.ok) {
    throw new Error(`Failed to get user: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.resource.uri;
}

async function getOrganization(userUri: string): Promise<string> {
  const response = await fetch(userUri, { headers });
  if (!response.ok) {
    throw new Error(`Failed to get user details: ${response.status}`);
  }
  const data = await response.json();
  return data.resource.current_organization;
}

async function listExistingWebhooks(orgUri: string): Promise<void> {
  const response = await fetch(
    `https://api.calendly.com/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=organization`,
    { headers }
  );
  if (!response.ok) {
    console.warn('Could not list webhooks:', response.status);
    return;
  }
  const data = await response.json();
  console.log('\n📋 Existing webhooks:');
  for (const wh of data.collection || []) {
    console.log(`   - ${wh.callback_url} (${wh.state}) [events: ${wh.events.join(', ')}]`);
  }
}

async function createWebhook(orgUri: string, userUri: string): Promise<void> {
  const body = {
    url: WEBHOOK_URL,
    events: ['invitee.created', 'invitee.canceled'],
    organization: orgUri,
    user: userUri,
    scope: 'user',
    signing_key: process.env.CALENDLY_WEBHOOK_SECRET || undefined,
  };

  console.log(`\n🔗 Creating webhook: ${WEBHOOK_URL}`);
  console.log(`   Events: invitee.created, invitee.canceled`);

  const response = await fetch('https://api.calendly.com/webhook_subscriptions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json();
    if (error.message?.includes('already exists') || error.title === 'Already Exists') {
      console.log('⚠️  Webhook already exists for this URL. No action needed.');
      return;
    }
    throw new Error(`Failed: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  const webhook = data.resource;

  console.log(`✅ Webhook created!`);
  console.log(`   URI: ${webhook.uri}`);
  console.log(`   State: ${webhook.state}`);
  console.log(`   Callback: ${webhook.callback_url}`);

  if (webhook.signing_key) {
    console.log(`\n⚠️  Signing key returned. Add to Vercel env vars:`);
    console.log(`   CALENDLY_WEBHOOK_SECRET=${webhook.signing_key}`);
  }
}

async function main() {
  try {
    console.log('🔍 Getting Calendly user info...');
    const userUri = await getCurrentUser();
    console.log(`   User: ${userUri}`);

    const orgUri = await getOrganization(userUri);
    console.log(`   Org: ${orgUri}`);

    await listExistingWebhooks(orgUri);
    await createWebhook(orgUri, userUri);

    console.log('\n📝 Next steps:');
    console.log('   1. Add CALENDLY_EMAIL_TEMPLATE_ID=158 to Vercel env vars');
    console.log('   2. Add CALENDLY_WEBHOOK_SECRET to Vercel env vars (if using signing)');
    console.log('   3. Ensure WP_APP_PASSWORD is set in Vercel');
    console.log('   4. Deploy: cd nexo-mail && vercel --prod');
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
