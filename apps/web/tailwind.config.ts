import type { Config } from 'tailwindcss';

/**
 * Design tokens.
 *
 * The palette is intentionally small: one indigo accent, a slate neutral ramp and three semantic
 * pairs. Every page composes those tokens, so a change here re-skins the whole dashboard without
 * touching a component. Typography stays on the system stack (no external font request, so the CSP
 * keeps `font-src 'self'`).
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0F172A', soft: '#475569', faint: '#8A97AB' },
        line: { DEFAULT: '#E6EAF0', strong: '#D3DAE5' },
        surface: { DEFAULT: '#FFFFFF', muted: '#F7F9FC', sunken: '#EFF3F9' },
        accent: { DEFAULT: '#4F46E5', soft: '#EEF0FF', strong: '#4338CA' },
        positive: { DEFAULT: '#047857', soft: '#E7F7F0' },
        caution: { DEFAULT: '#9A5B00', soft: '#FDF3E2' },
        danger: { DEFAULT: '#B42318', soft: '#FDECEA' },
        violet: { DEFAULT: '#7C3AED', soft: '#F3EEFF' },
      },
      fontFamily: { sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.03)',
        lift: '0 12px 28px -12px rgba(15,23,42,0.18)',
        pop: '0 18px 44px -18px rgba(15,23,42,0.28)',
        glow: '0 18px 40px -16px rgba(79,70,229,0.55)',
      },
      borderRadius: { xl2: '16px', xl3: '22px' },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg,#4F46E5 0%,#7C3AED 55%,#DB2777 100%)',
        'mesh': 'radial-gradient(circle at 15% 20%, rgba(99,102,241,0.30), transparent 45%), radial-gradient(circle at 85% 0%, rgba(168,85,247,0.28), transparent 40%), radial-gradient(circle at 60% 100%, rgba(236,72,153,0.22), transparent 45%)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'shimmer': { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.2,0.8,0.2,1)',
        'shimmer': 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
export default config;
