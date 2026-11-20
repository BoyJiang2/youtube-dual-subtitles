export const defaultTargetLanguage = 'zh-Hans';
export const defaultSourceLanguage = 'multi';

export const sourceLanguages = [
  { code: 'multi', label: '自动检测（多语言）' },
  { code: 'en', label: '英语 (English)' },
  { code: 'ja', label: '日语 (日本語)' },
  { code: 'ko', label: '韩语 (한국어)' },
  { code: 'es', label: '西班牙语 (Español)' },
  { code: 'fr', label: '法语 (Français)' },
  { code: 'de', label: '德语 (Deutsch)' },
  { code: 'ru', label: '俄语 (Русский)' },
  { code: 'pt', label: '葡萄牙语 (Português)' },
  { code: 'it', label: '意大利语 (Italiano)' },
  { code: 'zh', label: '中文 (普通话)' },
  { code: 'vi', label: '越南语' },
  { code: 'th', label: '泰语' },
  { code: 'id', label: '印度尼西亚语' },
  { code: 'ar', label: '阿拉伯语' },
  { code: 'hi', label: '印地语' },
];

export const targetLanguages = (
  'zh-Hans zh-Hant en ja ko es fr de pt pt-BR it ru vi th id ms fil ' +
  'ar hi bn ur fa he tr uk pl nl cs sk hu ro el sv da nb fi ' +
  'ta te mr gu pa kn ml sw sr hr bg'
).split(' ');
