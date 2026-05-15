import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  icon?: LucideIcon;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, hint, action, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-10 px-6',
        className,
      )}
    >
      {Icon && (
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/5 border border-white/10 text-white/40">
          <Icon size={22} />
        </div>
      )}
      <p className="text-sm font-medium text-white/80">{title}</p>
      {hint && <p className="mt-1 text-xs text-white/40">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
