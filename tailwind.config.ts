import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        rail: '#0A0A0A',
        railRaised: '#1B1B1E',
        canvas: '#FCFCFD',
        ink: '#111114',
        muted: '#6B6B76',
        faint: '#9A9AA5',
        line: '#E8E8EE',
        // Vert violet — primary actions, links and the AI's own voice.
        accent: { DEFAULT: '#5B2EE8', ink: '#4A22C8', soft: '#F2EEFE', line: '#DCD2FB' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(17,17,20,0.04)',
        lift: '0 8px 28px rgba(17,17,20,0.10)',
      },
    },
  },
  plugins: [],
};
export default config;
