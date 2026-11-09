import 'server-only'
import { clientIp } from './client-ip'

/**
 * Burst limits (wrangler.jsonc ratelimits): per verified user id and per
 * CF-Connecting-IP. Both must pass. Daily allowances are separate and durable
 * (the agent's meter and DailyCounter).
 */
export async function withinBurstLimits(
  env: CloudflareEnv,
  request: Request,
  userId: string
): Promise<boolean> {
  const [user, network] = await Promise.all([
    env.USER_BURST_LIMITER.limit({ key: `user:${userId}` }),
    env.IP_BURST_LIMITER.limit({ key: `ip:${clientIp(request)}` }),
  ])
  return user.success && network.success
}
