export type InputMode = 'timer' | 'typing'

export interface Settings {
  /** 'timer' = space-bar stopwatch, 'typing' = enter times by hand. */
  inputMode: InputMode
  /** Hide the running count while solving; the time still records normally. */
  hideTimeWhileSolving: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  inputMode: 'timer',
  hideTimeWhileSolving: false,
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
