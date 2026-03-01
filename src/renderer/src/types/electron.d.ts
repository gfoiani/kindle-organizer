import type { KindleAPI } from '../../../preload/api'

declare global {
  interface Window {
    kindleAPI: KindleAPI
  }
}

export {}
