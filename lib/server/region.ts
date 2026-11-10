import { regionFor, type Region } from '../region'

/**
 * Test runs only: the E2E server (scripts/e2e-server.mjs) sets
 * REGION_TEST_HEADER to "on" so a test can say which country it visits from
 * in this header. Anywhere else, and always in production, the header is
 * ignored: the country comes only from Cloudflare.
 */
export const TEST_COUNTRY_HEADER = 'x-wren-test-country'

/**
 * The visitor's region (lib/region.ts), from the country Cloudflare's edge
 * puts on the request (request.cf.country). Never from anything the browser
 * sends: not a request field, and not the CF-IPCountry header either, which a
 * client can send itself when the zone's geolocation header is off. Without a
 * country (local runs) the visitor gets the usual notice.
 */
export function visitorRegion(cf: unknown, headers: Headers, env: object): Region {
  const settings = env as Record<string, unknown>
  if (settings.APP_ENV !== 'production' && settings.REGION_TEST_HEADER === 'on') {
    const forced = headers.get(TEST_COUNTRY_HEADER)
    if (forced) return regionFor(forced)
  }
  const country = cf && typeof cf === 'object' ? (cf as { country?: unknown }).country : undefined
  return regionFor(typeof country === 'string' ? country : null)
}
