import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex flex-col items-center justify-center p-8">
      <main className="text-center max-w-2xl">
        <h1 className="text-5xl font-bold text-gray-900 mb-6">
          Nexo Mail
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Lead Automation System
        </p>
        <p className="text-gray-500 mb-12">
          Instagram → Google Sheet → API → Brevo → WooCommerce
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/dashboard"
            className="px-8 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            Open Dashboard
          </Link>
          <Link
            href="/api/health"
            className="px-8 py-3 bg-white text-gray-700 font-medium rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            Health Check
          </Link>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-6 text-left">
          <FeatureCard
            title="Webhook Receiver"
            description="Receives leads from Google Sheets via Apps Script"
            endpoint="/api/webhook/sheet"
          />
          <FeatureCard
            title="Brevo Integration"
            description="Automatically adds contacts to email lists"
            endpoint="/api/webhook/sheet"
          />
          <FeatureCard
            title="WooCommerce Sync"
            description="Tracks purchases and updates contact status"
            endpoint="/api/webhook/woocommerce"
          />
        </div>
      </main>

      <footer className="mt-16 text-gray-400 text-sm">
        Nexo Mail v1.0.0
      </footer>
    </div>
  );
}

function FeatureCard({
  title,
  description,
  endpoint,
}: {
  title: string;
  description: string;
  endpoint: string;
}) {
  return (
    <div className="bg-white rounded-lg p-6 shadow-sm">
      <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-500 text-sm mb-3">{description}</p>
      <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">
        {endpoint}
      </code>
    </div>
  );
}
