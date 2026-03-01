import { contextBridge } from 'electron'
import { kindleAPI } from './api'

contextBridge.exposeInMainWorld('kindleAPI', kindleAPI)
