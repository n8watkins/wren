/**
 * The wren: ink body, ember beak, cocked tail. Its parts move only to say what
 * Wren is doing (globals.css): idle (an occasional tail flick or head tilt),
 * thinking (hops and pecks), listening (head cocked), talking (a gentle bob).
 * Reduced motion stills all of them.
 */
export type WrenState = 'idle' | 'thinking' | 'listening' | 'talking' | 'still'

export function WrenMark({ size = 24, state = 'still', label }: { size?: number; state?: WrenState; label?: string }) {
  return (
    <svg
      className={state === 'still' ? 'wren' : `wren ${state}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
    >
      <g className="bd">
        <path className="tail" d="M7.4 17.2L4.7 6.2Q4.5 4.7 5.9 4.8Q7 4.9 7.4 6L11 14.8Z" />
        <g mask="url(#wren-wing)">
          <ellipse className="body" cx="15.2" cy="19.2" rx="9.4" ry="6.9" transform="rotate(-18 15.2 19.2)" />
        </g>
        <path className="legs" d="M13.8 25.2v3.6M17 25v3.6" />
        <g className="head" mask="url(#wren-eye)">
          <circle cx="22" cy="13.4" r="4.3" />
          <path className="beak" d="M25.8 12.3L29.9 13.6L25.9 14.7Z" />
        </g>
      </g>
    </svg>
  )
}
