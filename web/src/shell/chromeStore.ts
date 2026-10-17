// 外壳布局存储：仅存浏览器 localStorage（设备本地，不发给 agent、不参与同步；GPUI 自有一份）。
// 存储不可用（隐私模式等）时退化为内存默认布局，本次会话内仍可调整。
// 另含编辑态（是否在编辑、当前拖动项、悬停落点）：纯瞬时 UI 状态，不持久化。

import { useSyncExternalStore } from 'react'
import { CHROME_CATALOG } from './chromeCatalog'
import { defaultLayout, moveItem, normalizeLayout, serializeLayout } from './chromeLayout'
import type { ChromeLayout, ChromeZone } from './chromeLayout'

export const CHROME_LAYOUT_KEY = 'fluxdown.chromeLayout'

type Listener = () => void

// ── 布局 ──

const layoutListeners = new Set<Listener>()

function readStored(): ChromeLayout {
  try {
    const raw = localStorage.getItem(CHROME_LAYOUT_KEY)
    return normalizeLayout(raw === null ? null : JSON.parse(raw), CHROME_CATALOG)
  } catch {
    return defaultLayout(CHROME_CATALOG)
  }
}

let layout: ChromeLayout | null = null

export function getChromeLayout(): ChromeLayout {
  layout ??= readStored()
  return layout
}

function persist(next: ChromeLayout): void {
  layout = next
  try {
    localStorage.setItem(CHROME_LAYOUT_KEY, JSON.stringify(serializeLayout(next)))
  } catch {
    // 存储不可用：本次会话内以内存布局为准。
  }
  for (const listener of layoutListeners) listener()
}

/** 移动一个条目并在成功时立即持久化；返回是否发生了变化。 */
export function moveChromeItem(id: string, zone: ChromeZone, target: string | null): boolean {
  const result = moveItem(getChromeLayout(), CHROME_CATALOG, id, zone, target)
  if (result.changed) persist(result.layout)
  return result.changed
}

/** 重置为默认布局（写入完整默认值）。 */
export function resetChromeLayout(): void {
  persist(defaultLayout(CHROME_CATALOG))
}

// 其他标签页改了布局：重新读取并通知（仅在内容真的变化时替换快照，避免无谓重渲染）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CHROME_LAYOUT_KEY && event.key !== null) return
    const next = readStored()
    const current = getChromeLayout()
    if (JSON.stringify(serializeLayout(next)) === JSON.stringify(serializeLayout(current))) return
    layout = next
    for (const listener of layoutListeners) listener()
  })
}

function subscribeLayout(listener: Listener) {
  layoutListeners.add(listener)
  return () => {
    layoutListeners.delete(listener)
  }
}

export function useChromeLayout(): ChromeLayout {
  return useSyncExternalStore(subscribeLayout, getChromeLayout, getChromeLayout)
}

// ── 编辑态 ──

export interface ChromeEditState {
  editing: boolean
  /** 正在拖动的条目 id（dragover 读不到 dataTransfer 内容，只能存这里）。 */
  dragId: string | null
  /** 当前悬停的合法落点：`target` 为 null 表示区域空白处。 */
  hover: { zone: ChromeZone; target: string | null } | null
}

const IDLE: ChromeEditState = { editing: false, dragId: null, hover: null }
const editListeners = new Set<Listener>()
let edit: ChromeEditState = IDLE

function setEdit(next: ChromeEditState): void {
  edit = next
  for (const listener of editListeners) listener()
}

function subscribeEdit(listener: Listener) {
  editListeners.add(listener)
  return () => {
    editListeners.delete(listener)
  }
}

const getEdit = () => edit

export function useChromeEdit(): ChromeEditState {
  return useSyncExternalStore(subscribeEdit, getEdit, getEdit)
}

export function setChromeEditing(editing: boolean): void {
  if (edit.editing === editing) return
  setEdit(editing ? { editing, dragId: null, hover: null } : IDLE)
}

export function beginChromeDrag(id: string): void {
  setEdit({ ...edit, dragId: id, hover: null })
}

export function endChromeDrag(): void {
  if (edit.dragId === null && edit.hover === null) return
  setEdit({ ...edit, dragId: null, hover: null })
}

export function hoverChromeDrop(zone: ChromeZone, target: string | null): void {
  const hover = edit.hover
  if (hover?.zone === zone && hover.target === target) return
  setEdit({ ...edit, hover: { zone, target } })
}

/** 悬停离开某区域（仅当当前悬停仍属于该区域时才清除，避免覆盖已移到别处的悬停）。 */
export function leaveChromeDrop(zone: ChromeZone): void {
  if (edit.hover?.zone !== zone) return
  setEdit({ ...edit, hover: null })
}
