/**
 * The icon set from the mockups as one inline SVG sprite (rendered once in the
 * root layout), plus the masks the wren mark uses for its eye and wing.
 */
const SYMBOLS: Record<string, string> = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  res: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M4 10.5h13M10.5 4c-2.2 3.8-2.2 9.2 0 13M10.5 4c2.2 3.8 2.2 9.2 0 13M15.3 15.3 20.5 20.5"/>',
  mem: '<path d="M6.5 3.5h11v17l-5.5-3.8-5.5 3.8z"/>',
  note: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 12.5h6M9 16h3.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  file: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9 12.5h6M9 16h6"/>',
  fact: '<path d="M12 4.5l1.8 4.7 4.7 1.8-4.7 1.8L12 17.5l-1.8-4.7-4.7-1.8 4.7-1.8z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  edit: '<path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z"/><path d="m13.5 6.5 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clip: '<path d="m20.5 11.5-8.4 8.4a5 5 0 0 1-7.1-7.1l8.4-8.4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chat: '<path d="M4.5 5.5h15v10.5h-9.5l-5.5 4z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  right: '<path d="m10 7 5 5-5 5"/>',
  left: '<path d="m14 7-5 5 5 5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V5.5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m4 7 8 6 8-6"/>',
  git: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="9" r="2.2"/><path d="M7 8.2v7.6M17 11.2c0 3-3 3.5-10 4.6"/>',
  redo: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
  out: '<path d="M14 5H6.5v14H14M10.5 12H20M16.5 8.5 20 12l-3.5 3.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/>',
}

export type IconName = keyof typeof SYMBOLS

export function IconSprite() {
  const symbols = Object.entries(SYMBOLS)
    .map(([id, body]) => `<symbol id="i-${id}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('')
  const masks =
    '<mask id="wren-eye" maskUnits="userSpaceOnUse" x="-4" y="-4" width="40" height="40"><rect x="-4" y="-4" width="40" height="40" fill="#fff"/><circle cx="23.2" cy="12.5" r=".85" fill="#000"/></mask>' +
    '<mask id="wren-wing" maskUnits="userSpaceOnUse" x="-4" y="-4" width="40" height="40"><rect x="-4" y="-4" width="40" height="40" fill="#fff"/><path d="M10.4 18.4Q15.4 17.6 18.8 21.2" fill="none" stroke="#000" stroke-width="1.05" stroke-linecap="round"/></mask>'
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: `<defs>${masks}${symbols}</defs>` }}
    />
  )
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `i ${className}` : 'i'} aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  )
}
