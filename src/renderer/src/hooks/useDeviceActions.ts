import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KindleDrive } from '../../../preload/api'
import { STATUS_RESET_MS } from '../utils/constants'
import { errorMessageKey } from '../utils/appError'

export interface DeviceActions {
  isSyncing: boolean
  isEjecting: boolean
  /** The last write's outcome, shown for STATUS_RESET_MS. */
  syncResult: 'success' | 'error' | null
  writeToKindle: () => Promise<void>
  eject: () => Promise<void>
}

/**
 * Writing collections to the Kindle and ejecting it. Owned by App rather than
 * the header, which unmounts while Settings or About is shown: a write still
 * running when the user comes back must keep Eject disabled.
 */
export function useDeviceActions(
  kindle: KindleDrive | null,
  showInfo: (message: string) => void,
  showError: (message: string) => void
): DeviceActions {
  const { t } = useTranslation()
  const [isSyncing, setIsSyncing] = useState(false)
  const [isEjecting, setIsEjecting] = useState(false)
  const [syncResult, setSyncResult] = useState<'success' | 'error' | null>(null)

  async function writeToKindle(): Promise<void> {
    if (!kindle) return
    setIsSyncing(true)
    setSyncResult(null)
    try {
      const success = await window.kindleAPI.writeToKindle(kindle.mountpoint)
      setSyncResult(success ? 'success' : 'error')
    } catch (err) {
      console.error('Failed to write collections to Kindle:', err)
      setSyncResult('error')
    } finally {
      setIsSyncing(false)
      setTimeout(() => setSyncResult(null), STATUS_RESET_MS)
    }
  }

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

  return { isSyncing, isEjecting, syncResult, writeToKindle, eject }
}
