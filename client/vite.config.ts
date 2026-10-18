import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const site = env.VITE_SITE_URL?.replace(/\/$/, '');
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), tailwindcss(), {
      name: 'mediaflow-seo',
      transformIndexHtml(html) {
        return html.replaceAll('__SITE_URL__', site || '').replace(/<link rel="canonical" href=""\s*\/>/, '');
      },
      generateBundle() {
        const url = site || 'https://example.invalid';
        this.emitFile({ type: 'asset', fileName: 'robots.txt', source: site ? `User-agent: *\nAllow: /\nSitemap: ${url}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n' });
        this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${site ? `<url><loc>${url.replaceAll('&', '&amp;')}</loc></url>` : ''}</urlset>` });
      }
    }],
    server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } } },
    build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 350, rollupOptions: { output: { manualChunks: { motion: ['motion/react'] } } } }
  };
});
