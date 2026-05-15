import { cn } from '@/lib/utils';

interface Props {
  name?: string | null;
  initial?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

// Paleta de gradients pra avatares — deterministicamente pelo hash do nome
const GRADIENTS = [
  'from-aurora-blue to-aurora-purple',
  'from-aurora-purple to-aurora-pink',
  'from-aurora-blue to-cyan-400',
  'from-emerald-400 to-aurora-blue',
  'from-amber-400 to-rose-400',
  'from-rose-400 to-aurora-purple',
  'from-cyan-400 to-aurora-blue',
  'from-fuchsia-400 to-aurora-purple',
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h << 5) - h + name.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

const SIZE: Record<NonNullable<Props['size']>, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-14 w-14 text-lg',
  xl: 'h-20 w-20 text-2xl',
};

export function Avatar({ name, initial, size = 'md', className }: Props) {
  const display = (initial ?? name?.[0] ?? '?').toUpperCase();
  const gradient = GRADIENTS[hashName(name ?? display) % GRADIENTS.length]!;
  return (
    <div
      className={cn(
        'relative shrink-0 rounded-full font-semibold text-white shadow-glass',
        'bg-gradient-to-br flex items-center justify-center',
        gradient,
        SIZE[size],
        className,
      )}
    >
      <span className="relative z-10 drop-shadow">{display}</span>
      {/* Specular sheen */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'linear-gradient(180deg, rgba(255,255,255,0.30) 0%, transparent 40%)',
        }}
      />
    </div>
  );
}
