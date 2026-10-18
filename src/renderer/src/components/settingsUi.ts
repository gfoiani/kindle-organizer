/** Building blocks shared by the Settings sections. */

/** The one-line outcome a section shows under its buttons. */
export interface StatusLine {
  kind: 'success' | 'info' | 'error'
  text: string
}

export const STATUS_COLORS: Record<StatusLine['kind'], string> = {
  success: 'text-green-300',
  info: 'text-gray-300',
  error: 'text-red-300'
}

export const SECONDARY_BUTTON =
  'px-4 py-2 rounded-md text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-600 transition-colors disabled:opacity-50'
