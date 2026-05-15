import { Sidebar } from '@/components/layout/Sidebar';
import { AmbientBackground } from '@/components/layout/AmbientBackground';

export default function DashLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-screen overflow-hidden bg-ink-base text-white">
      <AmbientBackground />
      <div className="relative z-10 flex h-full">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-6 py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
