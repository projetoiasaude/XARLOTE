import { Zap } from 'lucide-react';
import { WhatsAppSimulator } from '@/components/simulator/WhatsAppSim';
import { GlassPanel, GlassBadge, SectionHeader } from '@/components/ui';

export default function SimulatorPage() {
  return (
    <div className="space-y-4">
      <SectionHeader
        icon={Zap}
        title="Simulador WhatsApp"
        subtitle="Teste a Xarlote sem precisar do uazapi"
        size="lg"
        action={<GlassBadge tone="info" dot>simulador</GlassBadge>}
      />
      <GlassPanel className="overflow-hidden" radius="3xl">
        <WhatsAppSimulator />
      </GlassPanel>
    </div>
  );
}
