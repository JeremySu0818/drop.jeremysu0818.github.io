import { createLiquidGlass } from 'https://esm.sh/solid-glass@0.0.3/engines/svg-refraction';
import { initPageEffects } from './modules/ui-effects.js';
import { initI18n } from './i18n.js';

await initI18n();
initPageEffects(createLiquidGlass);
