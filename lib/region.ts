/**
 * Where Google's terms reserve Gemini's free tier from apps, so Wren's demo
 * notice nudges harder toward the visitor's own key. Nothing is blocked:
 * Wren works the same everywhere (owner decision 2026-11-10, docs/DECISIONS.md).
 * Shared by the server (which reads the country) and the UI (the notice).
 *
 * Source: Google's Gemini API Additional Terms of Service
 * (https://ai.google.dev/gemini-api/terms, checked 2026-11-10): an app built on
 * the unpaid services may not be made available to users in the European
 * Economic Area, Switzerland or the United Kingdom, and free-tier users
 * shouldn't send personal information. The owner accepts that risk for the demo.
 *
 * Codes are ISO 3166-1 alpha-2, as Cloudflare reports them in request.cf.country.
 */
export const OWN_KEY_COUNTRIES: Readonly<Record<string, string>> = {
  // The 27 EU member states.
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  HR: 'Croatia',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DK: 'Denmark',
  EE: 'Estonia',
  FI: 'Finland',
  FR: 'France',
  DE: 'Germany',
  GR: 'Greece',
  HU: 'Hungary',
  IE: 'Ireland',
  IT: 'Italy',
  LV: 'Latvia',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MT: 'Malta',
  NL: 'the Netherlands',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SK: 'Slovakia',
  SI: 'Slovenia',
  ES: 'Spain',
  SE: 'Sweden',
  // Parts of the EU with their own country codes: Åland (Finland) and France's outermost regions.
  AX: 'the Åland Islands',
  GF: 'French Guiana',
  GP: 'Guadeloupe',
  MQ: 'Martinique',
  MF: 'Saint Martin',
  RE: 'Réunion',
  YT: 'Mayotte',
  // The rest of the EEA.
  IS: 'Iceland',
  LI: 'Liechtenstein',
  NO: 'Norway',
  // Switzerland and the United Kingdom.
  CH: 'Switzerland',
  GB: 'the United Kingdom',
}

/** Where the visitor is, as far as the demo notice is concerned. */
export interface Region {
  /** True in the EEA, Switzerland and the UK: the notice asks more firmly for the visitor's own key. */
  ownKeyAdvised: boolean
  /** The place's name when advised ("the United Kingdom"), for the notice; null otherwise. */
  name: string | null
}

export const ANY_REGION: Region = { ownKeyAdvised: false, name: null }

/** The region for a country code from Cloudflare; an unknown or missing code gets the usual notice. */
export function regionFor(country: string | null | undefined): Region {
  const code = country?.trim().toUpperCase() ?? ''
  const name = Object.hasOwn(OWN_KEY_COUNTRIES, code) ? OWN_KEY_COUNTRIES[code] : undefined
  return name ? { ownKeyAdvised: true, name } : ANY_REGION
}
