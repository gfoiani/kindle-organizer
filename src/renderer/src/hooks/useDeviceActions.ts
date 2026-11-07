import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleDrive } from '../../../preload/api'
import { errorMessageKey } from '../utils/appError'

export interface DeviceActions {
  isEjecting: boolean
  eject: () => Promise<void>
}

/**
 * Ejecting the Kindle. Owned by App rather than the header, which unmounts
 * while Settings or About is shown: an eject still running when the user comes
 * back must keep its button disabled.
 */
export function useDeviceActions(
  kindle: KindleDrive | null,
  showInfo: (message: string) => void,
  showError: (message: string) => void
): DeviceActions {
  const { t } = useTranslation()
  const [isEjecting, setIsEjecting] = useState(false)

  /**
   * Ejects the device. No optimistic clearing of the drive: the watcher's
   * disconnect push is what removes it, so a failed eject leaves the UI honest
   * about the device still being mounted.
   */
  async function eject(): Promise<void> {
    if (!kindle) return
    setIsEjecting(true)
    try {
      await window.kindleAPI.ejectKindle(kindle.mountpoint)
      showInfo(t('header.ejected'))
    } catch (err) {
      console.error('Failed to eject the Kindle:', err)
      showError(t(errorMessageKey(err, 'errors.ejectFailed')))
    } finally {
      setIsEjecting(false)
    }
  }

  return { isEjecting, eject }
}
