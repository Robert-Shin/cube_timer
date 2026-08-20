export type InputMode = 'timer' | 'typing'
export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  /** 'timer' = space-bar stopwatch, 'typing' = enter times by hand. */
  inputMode: InputMode
  /** Hide the running count while solving; the time still records normally. */
  hideTimeWhileSolving: boolean
  /** Ask which parities occurred after each solve, on events that have them. */
  trackParity: boolean
  /** 'system' follows the OS; the others override it in both directions. */
  theme: Theme
  /**
   * How strongly the stage background photo is dimmed, 0-1. The scrim is what
   * keeps the timer legible over an arbitrary photo, so it defaults high.
   */
  backgroundDim: number
}

export const DEFAULT_SETTINGS: Settings = {
  inputMode: 'timer',
  hideTimeWhileSolving: false,
  trackParity: false,
  theme: 'system',
  backgroundDim: 0.6,
}

const KEY = 'cube-timer.settings.v1'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    // Spread over defaults so settings added in future versions get a value.
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage disabled -- settings just won't persist past this session.
  }
}
