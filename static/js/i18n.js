const LOCALE_STORAGE_KEY = 'drop:locale';

const SUPPORTED_LOCALES = [
  { code: 'ar', label: 'العربية', direction: 'rtl' },
  { code: 'cs', label: 'Čeština' },
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'hu', label: 'Magyar' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'it', label: 'Italiano' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' },
  { code: 'pt-br', label: 'Português (Brasil)' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'zh-cn', label: '简体中文' },
  { code: 'zh-tw', label: '繁體中文' },
];

const SUPPORTED_CODES = new Set(SUPPORTED_LOCALES.map(({ code }) => code));
const textSource = new WeakMap();
const attributeSource = new WeakMap();
const translatableAttributes = ['aria-label', 'alt', 'placeholder', 'title'];

let baseMessages = {};
let messages = {};
let sourceToKey = new Map();
let activeLocale = 'en';
let initialized = false;

function flattenMessages(value, prefix = '', output = {}) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      flattenMessages(entry, `${prefix}${prefix ? '.' : ''}${index}`, output);
    });
    return output;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) => {
      flattenMessages(entry, `${prefix}${prefix ? '.' : ''}${key}`, output);
    });
    return output;
  }

  if (prefix && typeof value === 'string') output[prefix] = value;
  return output;
}

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function resolveLocale(locale) {
  const normalized = String(locale || '')
    .trim()
    .toLowerCase()
    .replace('_', '-');
  if (SUPPORTED_CODES.has(normalized)) return normalized;

  const primary = normalized.split('-')[0];
  if (SUPPORTED_CODES.has(primary)) return primary;
  if (primary === 'pt') return 'pt-br';
  if (primary === 'zh') {
    return /(?:tw|hk|mo|hant)/.test(normalized) ? 'zh-tw' : 'zh-cn';
  }

  return null;
}

function readStoredLocale() {
  try {
    return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function detectLocale() {
  const storedLocale = readStoredLocale();
  if (storedLocale) return storedLocale;

  const browserLocales = [
    ...(navigator.languages || []),
    navigator.language,
    document.documentElement.lang,
  ];
  return browserLocales.map(resolveLocale).find(Boolean) || 'en';
}

async function fetchLocale(locale) {
  const url = new URL(
    `../../assets/i18n/locales/${locale}.json`,
    import.meta.url,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load locale: ${locale}`);
  return response.json();
}

function format(value, variables = {}) {
  return String(value).replace(/\{(\w+)\}/g, (match, key) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : match,
  );
}

export function t(key, variables) {
  if (messages[key] !== undefined) {
    return format(messages[key], variables);
  }

  const fallback = baseMessages[key] ?? key;
  const equivalentStaticKey = sourceToKey.get(normalizeText(fallback));
  return format(messages[equivalentStaticKey] ?? fallback, variables);
}

function saveLocale(locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {}
}

function getAttributeEntry(element) {
  let entry = attributeSource.get(element);
  if (!entry) {
    entry = new Map();
    attributeSource.set(element, entry);
  }
  return entry;
}

function sourceKeyFor(value) {
  return sourceToKey.get(normalizeText(value));
}

function translateTextNodes() {
  const walker = document.createTreeWalker(
    document.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !parent ||
          ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(parent.tagName)
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return normalizeText(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    },
  );

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach((node) => {
    let source = textSource.get(node);
    if (!source) {
      source = node.nodeValue;
      textSource.set(node, source);
    }
    const key = sourceKeyFor(source);
    if (!key) return;

    const leading = source.match(/^\s*/)?.[0] || '';
    const trailing = source.match(/\s*$/)?.[0] || '';
    node.nodeValue = `${leading}${t(key)}${trailing}`;
  });
}

function translateAttributes() {
  document.querySelectorAll('*').forEach((element) => {
    translatableAttributes.forEach((attribute) => {
      if (!element.hasAttribute(attribute)) return;
      const entry = getAttributeEntry(element);
      const source = entry.get(attribute) ?? element.getAttribute(attribute);
      entry.set(attribute, source);
      const key = sourceKeyFor(source);
      if (key) element.setAttribute(attribute, t(key));
    });
  });

  document.querySelectorAll('meta[name="description"]').forEach((element) => {
    const entry = getAttributeEntry(element);
    const source = entry.get('content') ?? element.getAttribute('content');
    entry.set('content', source);
    const key = sourceKeyFor(source);
    if (key) element.setAttribute('content', t(key));
  });
}

function updateDocumentLanguage(locale, localeData) {
  const localeInfo = SUPPORTED_LOCALES.find(({ code }) => code === locale);
  document.documentElement.lang = locale;
  document.documentElement.dir =
    localeData.direction || localeInfo?.direction || 'ltr';
  document.documentElement.dataset.locale = locale;
}

function applyTranslations(locale, localeData) {
  updateDocumentLanguage(locale, localeData);
  translateTextNodes();
  translateAttributes();
}

function createLanguageSwitcher() {
  const nav = document.querySelector('.header-nav');
  if (!nav) return;

  let select = nav.querySelector('#languageSwitcher');
  let label = nav.querySelector('.language-switcher');
  if (!select) {
    label = document.createElement('label');
    label.className = 'language-switcher';
    select = document.createElement('select');
    select.id = 'languageSwitcher';
    select.className = 'language-switcher-select';

    SUPPORTED_LOCALES.forEach(({ code, label: localeLabel }) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = localeLabel;
      select.append(option);
    });

    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await setLocale(select.value, { persist: true });
      } finally {
        select.disabled = false;
      }
    });

    label.append(select);
    nav.append(label);
  }

  select.value = activeLocale;
  label.setAttribute('aria-label', t('common.language'));
  select.setAttribute('aria-label', t('common.language'));
  select.title = t('common.language');
}

async function loadLocale(locale) {
  const englishData = await fetchLocale('en');
  const localeData = locale === 'en' ? englishData : await fetchLocale(locale);
  baseMessages = flattenMessages(englishData.messages);
  messages = {
    ...baseMessages,
    ...flattenMessages(localeData.messages),
  };
  Object.entries(baseMessages).forEach(([key, value]) => {
    const source = normalizeText(value);
    if (!sourceToKey.has(source)) sourceToKey.set(source, key);
  });
  Object.entries(flattenMessages(localeData.messages)).forEach(([key, value]) => {
    const source = normalizeText(value);
    if (!sourceToKey.has(source)) sourceToKey.set(source, key);
  });
  return localeData;
}

export async function setLocale(locale, { persist = false } = {}) {
  const resolvedLocale = resolveLocale(locale) || 'en';
  let localeData;
  try {
    localeData = await loadLocale(resolvedLocale);
  } catch (error) {
    if (resolvedLocale === 'en') throw error;
    localeData = await loadLocale('en');
  }

  activeLocale = resolvedLocale;
  if (persist) saveLocale(resolvedLocale);
  applyTranslations(resolvedLocale, localeData);
  createLanguageSwitcher();
  window.dispatchEvent(
    new CustomEvent('i18n:changed', { detail: { locale: resolvedLocale } }),
  );
  return resolvedLocale;
}

export async function initI18n() {
  if (initialized) return activeLocale;
  initialized = true;
  try {
    return await setLocale(detectLocale());
  } catch {
    // Keep the original English HTML and, more importantly, keep the app usable
    // if a locale file is unavailable while the visitor is offline.
    activeLocale = 'en';
    document.documentElement.lang = 'en';
    document.documentElement.dir = 'ltr';
    return activeLocale;
  }
}

export function getLocale() {
  return activeLocale;
}

export { SUPPORTED_LOCALES };
