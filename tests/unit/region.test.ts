import { describe, expect, it } from 'vitest'
import { OWN_KEY_COUNTRIES, regionFor } from '../../lib/region'
import { TEST_COUNTRY_HEADER, visitorRegion } from '../../lib/server/region'
import { DEMO_NOTICE, regionNudge } from '../../components/app/DemoNotice'

const EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']
const PRODUCTION = { APP_ENV: 'production', REGION_TEST_HEADER: 'on' }
const TEST = { APP_ENV: 'test', REGION_TEST_HEADER: 'on' }
const none = new Headers()

describe('the own-key regions (lib/region.ts)', () => {
  it('cover the 27 EU states, the rest of the EEA, Switzerland and the UK', () => {
    expect(EU).toHaveLength(27)
    for (const code of [...EU, 'IS', 'LI', 'NO', 'CH', 'GB']) expect(regionFor(code).ownKeyAdvised, code).toBe(true)
  })

  it('leave everywhere else, and unknown or missing codes, with the usual notice', () => {
    for (const code of ['US', 'CA', 'JP', 'IN', 'BR', 'AU', 'TR', 'UA', 'RS', 'IM', 'JE', 'GG', 'GI', 'T1', 'XX', '', 'gbr', 'UK']) {
      expect(regionFor(code), code).toEqual({ ownKeyAdvised: false, name: null })
    }
    expect(regionFor(null).ownKeyAdvised).toBe(false)
    expect(regionFor(undefined).ownKeyAdvised).toBe(false)
  })

  it('names the place for the notice, whatever the case of the code', () => {
    expect(regionFor('gb')).toEqual({ ownKeyAdvised: true, name: 'the United Kingdom' })
    expect(regionFor(' de ')).toEqual({ ownKeyAdvised: true, name: 'Germany' })
    expect(Object.values(OWN_KEY_COUNTRIES).every((name) => name.length > 0)).toBe(true)
  })

  it("can't be fooled by inherited object keys", () => {
    expect(regionFor('constructor').ownKeyAdvised).toBe(false)
    expect(regionFor('__proto__').ownKeyAdvised).toBe(false)
  })
})

describe('visitorRegion (lib/server/region.ts)', () => {
  it("reads the country from Cloudflare's request.cf", () => {
    expect(visitorRegion({ country: 'FR' }, none, PRODUCTION)).toEqual({ ownKeyAdvised: true, name: 'France' })
    expect(visitorRegion({ country: 'US' }, none, PRODUCTION).ownKeyAdvised).toBe(false)
  })

  it('treats a missing or odd cf object as no country', () => {
    for (const cf of [undefined, null, {}, { country: 42 }, 'GB']) expect(visitorRegion(cf, none, PRODUCTION).ownKeyAdvised).toBe(false)
  })

  it('never trusts headers in production: not CF-IPCountry, not the test header', () => {
    const spoofed = new Headers({ 'cf-ipcountry': 'GB', [TEST_COUNTRY_HEADER]: 'GB' })
    expect(visitorRegion({ country: 'US' }, spoofed, PRODUCTION).ownKeyAdvised).toBe(false)
    expect(visitorRegion({ country: 'GB' }, new Headers({ [TEST_COUNTRY_HEADER]: 'US' }), PRODUCTION).ownKeyAdvised).toBe(true)
  })

  it('takes the test header only in a test run that turned it on', () => {
    const forced = new Headers({ [TEST_COUNTRY_HEADER]: 'CH' })
    expect(visitorRegion({ country: 'US' }, forced, TEST)).toEqual({ ownKeyAdvised: true, name: 'Switzerland' })
    expect(visitorRegion({ country: 'US' }, forced, { APP_ENV: 'test' }).ownKeyAdvised).toBe(false)
    expect(visitorRegion({ country: 'US' }, forced, { APP_ENV: 'test', REGION_TEST_HEADER: 'yes' }).ownKeyAdvised).toBe(false)
    expect(visitorRegion({ country: 'GB' }, none, TEST).ownKeyAdvised).toBe(true)
  })
})

describe('the demo notice', () => {
  it("says it is a free demo, asks for no personal details, and points to the visitor's own key", () => {
    expect(DEMO_NOTICE).toMatch(/free tier/)
    expect(DEMO_NOTICE).toMatch(/don't share personal details/)
    expect(DEMO_NOTICE).toMatch(/your own Gemini key/)
  })

  it('nudges harder, naming the place, only in the own-key regions', () => {
    expect(regionNudge(regionFor('GB'))).toMatch(/^You're visiting from the United Kingdom\. .*your own Gemini key/)
    expect(regionNudge(regionFor('US'))).toBeNull()
  })
})
