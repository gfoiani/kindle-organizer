import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import itTranslations from '../locales/it.json'
import enTranslations from '../locales/en.json'

const resources = {
  it: { translation: itTranslations },
  en: { translation: enTranslations }
}

// Get system language or default to English
const getInitialLanguage = (): string => {
  const stored = localStorage.getItem('language')
  if (stored) return stored

  const systemLang = navigator.language.split('-')[0]
  return ['it', 'en'].includes(systemLang) ? systemLang : 'en'
}

i18next.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false
  }
})

export default i18next
