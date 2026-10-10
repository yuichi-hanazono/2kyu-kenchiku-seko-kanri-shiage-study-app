import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');

  return {
    plugins: [react()],
    // GitHub Pages uses a repository sub-path while local development uses `/`.
    // Keep the default local-friendly and override it in the deployment workflow.
    base: env.VITE_BASE_PATH ?? '/',
  };
});
