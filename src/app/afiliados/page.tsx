'use client';

import { useState, useEffect, useCallback } from 'react';

interface Affiliate {
  codigo: string;
  nombre: string;
  email: string;
  whatsapp: string;
  alias: string;
  cbu: string;
  comision_pct: number;
  destino: string;
  fecha_alta: string;
  estado: string;
}

interface Sale {
  fecha: string;
  pedido: string;
  monto: string;
  codigo: string;
  nombre: string;
  comision: string;
  pagado: string;
}

interface CreateResponse {
  success: boolean;
  affiliate?: Affiliate;
  link?: string;
  message?: string;
  error?: string;
}

const DESTINOS: Record<string, string> = {
  recuperatuereccion: 'Recupera tu Erección',
  'control-eyaculacion-precoz': 'Control Eyaculación Precoz',
};

type Tab = 'crear' | 'afiliados' | 'ventas';

export default function AfiliadosPage() {
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem('afiliados_key') || '';
    return '';
  });
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [affiliates, setAffiliates] = useState<Affiliate[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('crear');

  // Filters
  const [filterAfiliado, setFilterAfiliado] = useState('');
  const [filterMes, setFilterMes] = useState('');

  // Form state
  const [nombre, setNombre] = useState('');
  const [email, setEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [alias, setAlias] = useState('');
  const [cbu, setCbu] = useState('');
  const [comisionPct, setComisionPct] = useState('20');
  const [destino, setDestino] = useState('recuperatuereccion');
  const [creating, setCreating] = useState(false);

  const fetchData = useCallback(async () => {
    if (!apiKey) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/affiliates?sales=true', {
        headers: { 'X-API-Key': apiKey },
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          setIsAuthenticated(false);
          setError('API key inválida');
        } else {
          setError(data.error || 'Error al cargar datos');
        }
        return;
      }
      setIsAuthenticated(true);
      localStorage.setItem('afiliados_key', apiKey);
      setAffiliates(data.affiliates || []);
      setSales(data.sales || []);
    } catch {
      setError('Error de red');
    } finally {
      setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (isAuthenticated) fetchData();
  }, [fetchData, isAuthenticated]);

  // Auto-login if key is saved
  useEffect(() => {
    if (apiKey && !isAuthenticated) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    fetchData();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setSuccess(null);
    setCreatedLink(null);

    try {
      const res = await fetch('/api/affiliates', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre,
          email,
          whatsapp,
          alias,
          cbu,
          comision_pct: parseFloat(comisionPct),
          destino,
        }),
      });

      const data: CreateResponse = await res.json();

      if (data.success && data.link) {
        setCreatedLink(data.link);
        setSuccess(`Afiliado creado. Email enviado a ${email}`);
        setNombre('');
        setEmail('');
        setWhatsapp('');
        setAlias('');
        setCbu('');
        setComisionPct('20');
        setDestino('recuperatuereccion');
        fetchData();
      } else {
        setError(data.error || 'Error al crear afiliado');
      }
    } catch {
      setError('Error de red');
    } finally {
      setCreating(false);
    }
  };

  const copyLink = (link: string) => {
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getLink = (a: Affiliate) => {
    if (a.destino === 'control-eyaculacion-precoz') {
      return `https://urologia.ar/cursos/control-eyaculacion-precoz/?ref=${a.codigo}`;
    }
    return `https://urologia.ar/go/${a.codigo}`;
  };

  // Parse date "d/m/yyyy" → { month, year, dateObj }
  const parseDate = (fecha: string) => {
    const parts = fecha.split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]);
      const year = parseInt(parts[2]);
      return { day, month, year, key: `${year}-${String(month).padStart(2, '0')}` };
    }
    return null;
  };

  // Get available months from sales
  const availableMonths = Array.from(
    new Set(
      sales
        .map((s) => {
          const d = parseDate(s.fecha);
          if (!d) return null;
          return d.key;
        })
        .filter(Boolean) as string[]
    )
  ).sort().reverse();

  const monthLabels: Record<string, string> = {};
  const meses = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  availableMonths.forEach((key) => {
    const [y, m] = key.split('-');
    monthLabels[key] = `${meses[parseInt(m)]} ${y}`;
  });

  // Add current month if not in list
  const now = new Date();
  const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (!availableMonths.includes(currentKey)) {
    availableMonths.unshift(currentKey);
    monthLabels[currentKey] = `${meses[now.getMonth() + 1]} ${now.getFullYear()}`;
  }

  // Filtered sales
  const filteredSales = sales.filter((s) => {
    if (filterAfiliado && s.codigo !== filterAfiliado) return false;
    if (filterMes) {
      const d = parseDate(s.fecha);
      if (!d || d.key !== filterMes) return false;
    }
    return true;
  });

  // Summary from filtered sales
  const filteredSummary = filteredSales.reduce(
    (acc, s) => {
      if (!acc[s.codigo]) {
        acc[s.codigo] = { nombre: s.nombre, ventas: 0, total: 0, comision: 0 };
      }
      acc[s.codigo].ventas++;
      acc[s.codigo].total += parseFloat(s.monto) || 0;
      acc[s.codigo].comision += parseFloat(s.comision) || 0;
      return acc;
    },
    {} as Record<string, { nombre: string; ventas: number; total: number; comision: number }>
  );

  const totalVentas = filteredSales.length;
  const totalMonto = filteredSales.reduce((sum, s) => sum + (parseFloat(s.monto) || 0), 0);
  const totalComision = filteredSales.reduce((sum, s) => sum + (parseFloat(s.comision) || 0), 0);

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-md p-8 max-w-md w-full">
          <h1 className="text-2xl font-bold text-[#152735] mb-2 text-center">Afiliados</h1>
          <p className="text-gray-500 text-sm text-center mb-6">urologia.ar</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-md mb-4 focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
              placeholder="API Key"
              required
            />
            {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-[#152735] text-white py-2 px-4 rounded-md hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Cargando...' : 'Entrar'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-[#152735] shadow">
        <div className="max-w-5xl mx-auto px-4 py-5 sm:px-6 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-white">Afiliados</h1>
            <p className="text-white/50 text-sm">urologia.ar</p>
          </div>
          <button
            onClick={() => { setIsAuthenticated(false); setApiKey(''); localStorage.removeItem('afiliados_key'); }}
            className="text-white/60 hover:text-white text-sm"
          >
            Salir
          </button>
        </div>
      </header>
      <div className="h-[3px] bg-[#5ac8fa]" />

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex">
          {([
            { id: 'crear' as Tab, label: 'Nuevo afiliado' },
            { id: 'afiliados' as Tab, label: `Afiliados (${affiliates.length})` },
            { id: 'ventas' as Tab, label: `Ventas (${sales.length})` },
          ]).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-[#5ac8fa] text-[#152735]'
                  : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-4 py-6 sm:px-6 space-y-6">

        {/* Alerts */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
            {error}
            <button onClick={() => setError(null)} className="float-right font-bold">&times;</button>
          </div>
        )}
        {success && (
          <div className="bg-[#eefaf6] border border-[#48c9b0] text-[#152735] px-4 py-3 rounded-md">
            {success}
            <button onClick={() => setSuccess(null)} className="float-right font-bold">&times;</button>
          </div>
        )}

        {/* Created link highlight */}
        {createdLink && activeTab === 'crear' && (
          <div className="bg-white rounded-lg shadow p-6 border-l-4 border-[#48c9b0]">
            <p className="text-sm text-gray-500 mb-2">Link del nuevo afiliado:</p>
            <div className="flex items-center gap-3">
              <code className="flex-1 bg-gray-100 px-4 py-3 rounded text-[#152735] font-bold break-all">
                {createdLink}
              </code>
              <button
                onClick={() => copyLink(createdLink)}
                className="bg-[#E67E22] text-white px-5 py-3 rounded-full font-bold text-sm hover:opacity-90 whitespace-nowrap"
              >
                {copied ? '¡Copiado!' : 'Copiar'}
              </button>
            </div>
          </div>
        )}

        {/* ============ TAB: CREAR ============ */}
        {activeTab === 'crear' && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-bold text-[#152735] mb-4 border-b-2 border-[#5ac8fa] pb-2 inline-block">
              Nuevo afiliado
            </h2>
            <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nombre *</label>
                <input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  placeholder="Lic. Mili Burgos"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  placeholder="mili@email.com"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">WhatsApp</label>
                <input
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  placeholder="+54 9 261 ..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Alias (bancario)</label>
                <input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  placeholder="mili.burgos.mp"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">CBU</label>
                <input
                  value={cbu}
                  onChange={(e) => setCbu(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  placeholder="0000003100..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Comisión %</label>
                <input
                  type="number"
                  value={comisionPct}
                  onChange={(e) => setComisionPct(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                  min="1"
                  max="50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Destino</label>
                <select
                  value={destino}
                  onChange={(e) => setDestino(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-[#5ac8fa] focus:border-transparent"
                >
                  <option value="recuperatuereccion">Recupera tu Erección</option>
                  <option value="control-eyaculacion-precoz">Control Eyaculación Precoz</option>
                </select>
              </div>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={creating}
                  className="w-full bg-[#E67E22] text-white py-2 px-6 rounded-full font-bold hover:opacity-90 disabled:opacity-50"
                >
                  {creating ? 'Creando...' : 'Crear afiliado'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ============ TAB: AFILIADOS ============ */}
        {activeTab === 'afiliados' && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
              <h2 className="text-lg font-bold text-[#152735]">
                Afiliados activos
              </h2>
              <button
                onClick={fetchData}
                disabled={loading}
                className="text-sm text-[#5ac8fa] hover:underline disabled:opacity-50"
              >
                {loading ? 'Cargando...' : 'Actualizar'}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Código</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Nombre</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Destino</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Comisión</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Link</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Alta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {affiliates.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                        No hay afiliados todavía
                      </td>
                    </tr>
                  ) : (
                    affiliates.map((a) => {
                      const link = getLink(a);
                      return (
                        <tr key={a.codigo} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-mono font-bold text-[#152735]">{a.codigo}</td>
                          <td className="px-4 py-3 text-sm">{a.nombre}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{DESTINOS[a.destino] || a.destino}</td>
                          <td className="px-4 py-3 text-sm">{a.comision_pct}%</td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => copyLink(link)}
                              className="text-xs bg-[#152735] text-white px-3 py-1 rounded-full hover:opacity-90"
                            >
                              Copiar link
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-400">{a.fecha_alta}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============ TAB: VENTAS ============ */}
        {activeTab === 'ventas' && (
          <>
            {/* Totals */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white rounded-lg shadow p-4 text-center">
                <p className="text-sm text-gray-500">Ventas</p>
                <p className="text-2xl font-bold text-[#152735]">{totalVentas}</p>
              </div>
              <div className="bg-white rounded-lg shadow p-4 text-center">
                <p className="text-sm text-gray-500">Total vendido</p>
                <p className="text-2xl font-bold text-[#152735]">${totalMonto.toFixed(2)}</p>
              </div>
              <div className="bg-white rounded-lg shadow p-4 text-center">
                <p className="text-sm text-gray-500">Comisiones</p>
                <p className="text-2xl font-bold text-[#48c9b0]">${totalComision.toFixed(2)}</p>
              </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-lg shadow p-4 flex flex-wrap gap-4 items-end">
              <div className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Afiliado</label>
                <select
                  value={filterAfiliado}
                  onChange={(e) => setFilterAfiliado(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Todos</option>
                  {affiliates.map((a) => (
                    <option key={a.codigo} value={a.codigo}>
                      {a.codigo} — {a.nombre}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-gray-500 mb-1">Mes</label>
                <select
                  value={filterMes}
                  onChange={(e) => setFilterMes(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                >
                  <option value="">Todos</option>
                  {availableMonths.map((key) => (
                    <option key={key} value={key}>
                      {monthLabels[key]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => { setFilterAfiliado(''); setFilterMes(''); }}
                className="text-sm text-gray-400 hover:text-gray-600 pb-2"
              >
                Limpiar filtros
              </button>
            </div>

            {/* Summary by affiliate */}
            {Object.keys(filteredSummary).length > 0 && (
              <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="px-6 py-3 border-b border-gray-200">
                  <h3 className="text-sm font-bold text-[#152735]">Resumen por afiliado</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Afiliado</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ventas</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Comisión</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {Object.entries(filteredSummary).map(([code, data]) => (
                        <tr key={code} className="hover:bg-gray-50">
                          <td className="px-4 py-2 text-sm">
                            <span className="font-mono font-bold text-[#152735]">{code}</span>
                            <span className="text-gray-400 ml-2">{data.nombre}</span>
                          </td>
                          <td className="px-4 py-2 text-sm font-bold">{data.ventas}</td>
                          <td className="px-4 py-2 text-sm">${data.total.toFixed(2)}</td>
                          <td className="px-4 py-2 text-sm font-bold text-[#48c9b0]">${data.comision.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Sales detail */}
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="px-6 py-3 border-b border-gray-200 flex justify-between items-center">
                <h3 className="text-sm font-bold text-[#152735]">Detalle de ventas ({filteredSales.length})</h3>
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="text-xs text-[#5ac8fa] hover:underline disabled:opacity-50"
                >
                  {loading ? '...' : 'Actualizar'}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Fecha</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Pedido</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Monto</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Afiliado</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Comisión</th>
                      <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Pagado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {filteredSales.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                          Sin ventas{filterAfiliado || filterMes ? ' con estos filtros' : ''}
                        </td>
                      </tr>
                    ) : (
                      filteredSales.map((s, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-4 py-2 text-sm text-gray-500">{s.fecha}</td>
                          <td className="px-4 py-2 text-sm font-mono">#{s.pedido}</td>
                          <td className="px-4 py-2 text-sm font-bold">${s.monto}</td>
                          <td className="px-4 py-2 text-sm">
                            <span className="font-mono text-[#152735]">{s.codigo}</span>
                            <span className="text-gray-400 ml-1">{s.nombre}</span>
                          </td>
                          <td className="px-4 py-2 text-sm font-bold text-[#48c9b0]">${s.comision}</td>
                          <td className="px-4 py-2 text-sm">{s.pagado}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

      </main>
    </div>
  );
}
