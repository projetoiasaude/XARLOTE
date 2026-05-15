import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Cabeçalho de seção consistente — substitui h2 inline espalhados.
 * Ex: <SectionHeader icon={Brain} title="Memória" subtitle="o que aprendeu" />
 */
export function SectionHeader({ icon: Icon, title, subtitle, action, size = 'md', className }: Props) {
  const titleSize = size === 'lg' ? 'text-xl' : size === 'sm' ? 'text-sm' : 'text-base';
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-3 min-w-0">
        {Icon && (
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5 border border-white/10 text-accent-hi">
            <Icon size={18} />
          </div>
        )}
        <div className="min-w-0">
          <h2 className={cn('font-semibold text-white tracking-tight', titleSize)}>{title}</h2>
          {subtitle && <p className="text-xs text-white/50 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
