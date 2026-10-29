import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BRAILLE_SPINNER_FRAMES, RunningTasksBadge } from './running-tasks-badge'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  )
})

const badge = () => document.querySelector('[data-slot="nav-running-badge"]') as HTMLElement

describe('RunningTasksBadge', () => {
  it('shows the spinner and the running count', () => {
    render(<RunningTasksBadge count={3} />)
    expect(badge().textContent).toContain('3')
    expect(badge().textContent).toContain(BRAILLE_SPINNER_FRAMES[0])
    expect(badge().getAttribute('title')).toBe('3 running tasks')
  })

  it('names the count accessibly without spelling the spinner glyph', () => {
    render(<RunningTasksBadge count={1} />)
    expect(badge().getAttribute('title')).toBe('1 running task')
    const announced = badge().querySelector('.sr-only')
    expect(announced?.textContent).toBe('1 running')
    expect(badge().querySelector('[aria-hidden="true"]')?.textContent).toBe(BRAILLE_SPINNER_FRAMES[0])
  })

  it('cycles the braille frames while mounted', () => {
    vi.useFakeTimers()
    render(<RunningTasksBadge count={2} />)
    const seen = new Set([badge().textContent])
    for (let i = 0; i < BRAILLE_SPINNER_FRAMES.length; i += 1) {
      act(() => vi.advanceTimersByTime(80))
      seen.add(badge().textContent)
    }
    // Every frame differs from the first only in the spinner glyph — that is the animation.
    expect(seen.size).toBe(BRAILLE_SPINNER_FRAMES.length)
  })

  it('holds the first frame still under reduced motion', () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'matchMedia',
      () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })
    )
    render(<RunningTasksBadge count={2} />)
    act(() => vi.advanceTimersByTime(800))
    expect(badge().textContent).toContain(BRAILLE_SPINNER_FRAMES[0])
    // The count still shows — reduced motion removes the animation, not the information.
    expect(badge().textContent).toContain('2')
  })
})
