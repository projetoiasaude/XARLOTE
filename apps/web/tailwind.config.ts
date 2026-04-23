import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0fdf4',
          500: '#22c55e',
          600: '#16a34a',
          900: '#14532d',
        },
        wa: {
          bg: '#0b141a',
          panel: '#111b21',
          bubble_out: '#005c4b',
          bubble_in: '#202c33',
          input: '#2a3942',
          border: '#222d34',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
