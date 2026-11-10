import 'server-only'
import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'
import { sendSignInEmail } from './email'
import { optionalSetting } from '../secrets'

/**
 * Accounts and sessions with Better Auth on D1 (docs/DECISIONS.md, Sign-in).
 * Two ways in, nothing else: GitHub, and a one-time link by email. Sessions
 * live in D1 and are checked on the server for every API call
 * (lib/server/session.ts).
 */
export function createAuth(env: CloudflareEnv) {
  const githubId = optionalSetting(env, 'GITHUB_CLIENT_ID')
  const githubSecret = optionalSetting(env, 'GITHUB_CLIENT_SECRET')
  const https = new URL(env.PUBLIC_URL).protocol === 'https:'
  return betterAuth({
    appName: 'Wren',
    baseURL: env.PUBLIC_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.PUBLIC_URL],
    emailAndPassword: { enabled: false },
    socialProviders:
      githubId && githubSecret
        ? {
            github: {
              clientId: githubId,
              clientSecret: githubSecret,
              scope: ['read:user', 'user:email'],
              // Each GitHub sign-in refreshes the name (GitHub's display name,
              // else the username). An account first made with an email link has
              // no name, and linking GitHub later doesn't add one otherwise.
              overrideUserInfoOnSignIn: true,
            },
          }
        : {},
    plugins: [
      magicLink({
        expiresIn: 10 * 60,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => sendSignInEmail(env, email, url),
      }),
    ],
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    // Workers don't share memory between requests, so Better Auth's in-memory
    // limiter would count nothing; the route applies durable limits instead
    // (app/api/auth/[...all]/route.ts).
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: https,
      // Sessions don't keep the visitor's IP or browser.
      ipAddress: { disableIpTracking: true },
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        update: {
          before: async (user, context) => {
            const data = oauthNameOnly(user, context?.path)
            // Nothing left to change: skip the update rather than run an empty one.
            return Object.keys(data).length ? { data } : false
          },
        },
      },
    },
  })
}

/**
 * What a sign-in with GitHub may change on an existing user: the name only.
 * The email they sign in with never changes behind their back (Better Auth's
 * override would copy GitHub's primary email), and the avatar isn't used.
 */
export function oauthNameOnly<T extends Record<string, unknown>>(user: T, path: string | undefined): Partial<T> {
  if (!path?.startsWith('/callback')) return user
  const { name } = user
  return (typeof name === 'string' && name.trim() ? { name: name.trim() } : {}) as Partial<T>
}

/** Which sign-in methods this deployment can offer. */
export function signInMethods(env: CloudflareEnv): { github: boolean; email: boolean } {
  return {
    github: Boolean(optionalSetting(env, 'GITHUB_CLIENT_ID') && optionalSetting(env, 'GITHUB_CLIENT_SECRET')),
    email: true,
  }
}
