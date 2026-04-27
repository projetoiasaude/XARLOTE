import Link from 'next/link';
import { Zap, MessageCircle, ShoppingBag, Activity } from 'lucide-react';

export default function OverviewPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-white mb-1">Dashboard IA da Saúde</h1>
      <p className="text-gray-400 mb-8">Cockpit operacional em tempo real</p>

      <div className="grid grid-cols-2 gap-4 mb-8">
        <Card href="/simulator" icon={<Zap className="text-yellow-400" />} title="Simulador WhatsApp" desc="Teste a Xarlote sem precisar do uazapi. Envie mensagens, imagens e localização." cta="Abrir simulador" color="yellow" />
        <Card href="/conversations" icon={<MessageCircle className="text-blue-400" />} title="Conversas" desc="Todas as conversas com usuários em tempo real via Supabase Realtime." cta="Ver conversas" color="blue" />
        <Card href="/orders" icon={<ShoppingBag className="text-green-400" />} title="Pedidos" desc="Acompanhe ordens de medicamentos e cotações com farmácias." cta="Ver pedidos" color="green" />
        <Card href="/logs" icon={<Activity className="text-purple-400" />} title="Logs" desc="Stream de logs do sistema em tempo real." cta="Ver logs" color="purple" />
      </div>

      <div className="bg-wa-panel border border-wa-border rounded-xl p-6">
        <h2 className="text-white font-semibold mb-3">🚀 Como começar</h2>
        <ol className="space-y-2 text-sm text-gray-400">
          <li>1. Abra o <strong className="text-white">Simulador WhatsApp</strong> e escolha um número de telefone</li>
          <li>2. Envie qualquer mensagem — Xarlote vai responder via OpenRouter</li>
          <li>3. Na primeira mensagem, Xarlote pedirá o aceite LGPD</li>
          <li>4. Depois do aceite, você pode pedir medicamentos, criar lembretes, etc.</li>
          <li>5. Para cotar farmácias: peça um remédio e mande uma localização</li>
        </ol>
      </div>
    </div>
  );
}

function Card({ href, icon, title, desc, cta, color }: { href: string; icon: React.ReactNode; title: string; desc: string; cta: string; color: string }) {
  const colorMap: Record<string, string> = {
    yellow: 'border-yellow-400/20 hover:border-yellow-400/50',
    blue: 'border-blue-400/20 hover:border-blue-400/50',
    green: 'border-green-400/20 hover:border-green-400/50',
    purple: 'border-purple-400/20 hover:border-purple-400/50',
  };
  return (
    <Link href={href} className={`bg-wa-panel border rounded-xl p-5 hover:bg-wa-bubble_in/30 transition-colors ${colorMap[color] ?? ''}`}>
      <div className="flex items-center gap-2 mb-2">{icon}<h3 className="text-white font-medium">{title}</h3></div>
      <p className="text-gray-400 text-sm mb-3">{desc}</p>
      <span className="text-xs text-gray-500">{cta} →</span>
    </Link>
  );
}
