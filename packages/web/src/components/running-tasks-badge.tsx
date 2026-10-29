import { useEffect, useState } from 'react'

/** The ten braille dots of the classic terminal spinner, one frame per tick. */
export const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const FRAME_MS = 80
const REDUCE_MOTION = '(prefers-reduced-motion: reduce)'

/** Live `prefers-reduced-motion`. Where `matchMedia` is missing (jsdom) the answer is
 *  "don't animate", so the suites never schedule a timer — same convention as
 *  `ghost-code-backdrop.tsx`. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window.matchMedia !== 'function' || window.matchMedia(REDUCE_MOTION).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCE_MOTION)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * How many tasks are running right now, for the sidebar's All tasks door: a braille
 * spinner beside the count, in the same violet count grammar as the Inbox and unread
 * badges. Mounted only while the count is positive, so no timer runs on an idle
 * workspace; under reduced motion the first frame holds still and the count remains.
 */
export function RunningTasksBadge({ count }: { count: number }) {
  const [frame, setFrame] = useState(0)
  const reducedMotion = usePrefersReducedMotion()
  useEffect(() => {
    if (reducedMotion) return
    const id = window.setInterval(
      () => setFrame((current) => (current + 1) % BRAILLE_SPINNER_FRAMES.length),
      FRAME_MS,
    )
    return () => window.clearInterval(id)
  }, [reducedMotion])
  return (
    <span
      data-slot="nav-running-badge"
      title={`${count} running ${count === 1 ? 'task' : 'tasks'}`}
      className="ml-auto flex items-center gap-1 rounded-full bg-violet px-1.5 py-px text-[10.5px] font-semibold text-violet-foreground"
    >
      <span aria-hidden="true">{BRAILLE_SPINNER_FRAMES[frame]}</span>
      <span className="tabular-nums" aria-hidden="true">{count}</span>
      <span className="sr-only">{`${count} running`}</span>
    </span>
  )
}
