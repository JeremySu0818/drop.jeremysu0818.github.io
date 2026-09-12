import { initI18n } from './i18n.js';
import { prepareInitialBackground } from './modules/ui-effects.js';

const entrypoints = {
  about: './about.js',
  app: './app.js',
  receive: './receive.js',
};

const entry = new URL(import.meta.url).searchParams.get('entry');

try {
  await Promise.all([initI18n(), prepareInitialBackground()]);
} finally {
  document.documentElement.classList.remove('i18n-loading');
}

if (entrypoints[entry]) {
  await import(entrypoints[entry]);
}
