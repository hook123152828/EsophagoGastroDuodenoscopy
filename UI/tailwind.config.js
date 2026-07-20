/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#E9EDF2',
        paperTint: '#F0F4F8',
        surface: '#FFFFFF',
        sunken: '#F3F6FA',
        ink: '#0E1B27',
        inkSoft: '#566472',
        inkFaint: '#8A98A6',
        line: '#DBE3EB',
        lineSoft: '#E8EEF3',
        brand: '#0B6E63',
        brandDeep: '#075049',
        brandTint: '#E4F1EF',
        wl: '#B7740F',
        nbi: '#1787A8',
        im: '#CE1F5E',
        ok: '#1E9E68',
      },
      fontFamily: {
        display: ['Space Grotesk', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', 'sans-serif'],
        sans: ['IBM Plex Sans', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(14,27,39,.05), 0 1px 1px rgba(14,27,39,.04)',
        md: '0 2px 4px rgba(14,27,39,.04), 0 12px 28px -12px rgba(14,27,39,.16)',
        lg: '0 4px 8px rgba(14,27,39,.05), 0 24px 48px -16px rgba(14,27,39,.22)',
      },
    },
  },
  plugins: [],
}
