import { Cloud, CloudAlert, CloudCheck, CloudOff, CloudUpload } from 'lucide-react'

/** One icon per sync summary tone. */
export const SYNC_ICONS = { ok: CloudCheck, busy: CloudUpload, warn: CloudAlert, error: CloudOff, muted: Cloud } as const
