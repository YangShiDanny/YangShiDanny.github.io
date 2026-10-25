import en from './en';
import zh from './zh';

export type Locale = 'en' | 'zh';
const translations: Record<Locale, typeof en> = {
  en,
  zh
};
export default translations;
