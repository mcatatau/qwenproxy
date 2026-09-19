import type { QwenAccount} from './accounts.js';
import { loadAccounts, updateAccountCooldown, invalidateAccountsCache as invalidateAccountsCacheSource } from './accounts.js'
import { config } from './config.js'
import { getBaseAccountId, makeAccountLaneId } from './account-lanes.js'
import { RetryableQwenStreamError } from '../services/error-handler.js'
import { getRuntimeInt } from './runtime-config.js'

let currentIndex = 0
const inUseAccounts = new Set<string>()

interface CooldownEntry {
  until: number
  reason: string
}

const cooldowns = new Map<string, CooldownEntry>()

const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000

function expandSingleAccountLanes(accounts: QwenAccount[]): QwenAccount[] {
  if (!config.accounts.singleAccountMode) return accounts

  const selected = accounts.find(account => {
    if (config.accounts.singleAccountId) return account.id === config.accounts.singleAccountId
    if (config.accounts.singleAccountEmail) return account.email === config.accounts.singleAccountEmail
    return !account.cooldown_until || account.cooldown_until <= Date.now()
  }) || accounts[0]

  if (!selected) return []

  return Array.from({ length: config.accounts.lanes }, (_, index) => ({
    ...selected,
    id: makeAccountLaneId(selected.id, index + 1),
    email: `${selected.email}#lane-${index + 1}`,
  }))
}

function getAccountsWithCooldownSync(): QwenAccount[] {
  const accounts = expandSingleAccountLanes(loadAccounts())
  const now = Date.now()

  for (const account of accounts) {
    const baseAccountId = getBaseAccountId(account.id)
    const cooldownUntil = account.cooldown_until || cooldowns.get(baseAccountId)?.until || 0
    const cooldownReason = account.cooldown_reason || cooldowns.get(baseAccountId)?.reason || 'RateLimited'

    if (cooldownUntil && cooldownUntil > now) {
      cooldowns.set(account.id, {
        until: cooldownUntil,
        reason: cooldownReason,
      })
    } else {
      cooldowns.delete(account.id)
    }
  }

  return accounts
}

export function invalidateAccountsCache(): void {
  invalidateAccountsCacheSource()
}

export function markAccountRateLimited(accountId: string, cooldownMs?: number, reason?: string): void {
  const baseAccountId = getBaseAccountId(accountId)
  const duration = cooldownMs ?? DEFAULT_COOLDOWN_MS
  const until = Date.now() + duration
  const cooldownReason = reason ?? 'RateLimited'

  cooldowns.set(accountId, {
    until,
    reason: cooldownReason,
  })
  cooldowns.set(baseAccountId, {
    until,
    reason: cooldownReason,
  })

  if (baseAccountId !== 'global') {
    try {
      updateAccountCooldown(baseAccountId, until, cooldownReason)
    } catch (err) {
      console.error(`[AccountManager] Failed to save cooldown to DB for account ${baseAccountId}:`, (err as Error).message)
    }
  }

  console.log(`[AccountManager] Account ${accountId} marked as rate-limited. Cooldown until ${new Date(until).toISOString()}`)
}

export function clearAccountCooldown(accountId: string): void {
  const baseAccountId = getBaseAccountId(accountId)
  cooldowns.delete(accountId)
  cooldowns.delete(baseAccountId)
  if (baseAccountId !== 'global') {
    try {
      updateAccountCooldown(baseAccountId, 0, null)
    } catch (err) {
      console.error(`[AccountManager] Failed to clear cooldown in DB for account ${baseAccountId}:`, (err as Error).message)
    }
  }
}

export function getAccountCooldownInfo(accountId: string): { onCooldown: boolean; remainingMs: number; reason: string } | null {
  const baseAccountId = getBaseAccountId(accountId)
  const entry = cooldowns.get(accountId) || cooldowns.get(baseAccountId)
  if (!entry) return null
  const remaining = entry.until - Date.now()
  if (remaining <= 0) {
    cooldowns.delete(accountId)
    cooldowns.delete(baseAccountId)
    if (baseAccountId !== 'global') {
      try {
        updateAccountCooldown(baseAccountId, 0, null)
      } catch (err) {
        console.error(`[AccountManager] Failed to clear expired cooldown in DB:`, (err as Error).message)
      }
    }
    return null
  }
  return { onCooldown: true, remainingMs: remaining, reason: entry.reason }
}

function isAccountOnCooldown(accountId: string): boolean {
  return getAccountCooldownInfo(accountId) !== null
}

function isAccountInUse(accountId: string): boolean {
  return inUseAccounts.has(accountId)
}

export function markAccountInUse(accountId: string): void {
  inUseAccounts.add(accountId)
}

export function releaseAccountInUse(accountId: string): void {
  inUseAccounts.delete(accountId)
}

// ---------------------------------------------------------------------------
// Load-aware scheduling across multiple accounts.
// The router prefers the account with the fewest actively streaming slots
// (all lanes of an account share one bucket), and requests that cannot find a
// free account wait on a signal instead of polling fixed intervals.
// ---------------------------------------------------------------------------

// Ready lanes: browser context created, the page is on the chat.qwen.ai origin
// AND the anti-bot headers (bx-ua/bx-umidtoken) were already captured for it.
// The router prefers ready lanes so incoming requests never land on a lane that
// is still being warmed (page navigation / header interception). Otherwise a
// request right after startup hits a lane mid-warmup and fails with "Cannot
// fetch Qwen completion outside an active Qwen browser page".
const readyAccounts = new Set<string>()

export function markAccountReady(accountId: string): void {
  if (!accountId) return
  readyAccounts.add(accountId)
}

export function markAccountNotReady(accountId: string): void {
  if (!accountId) return
  readyAccounts.delete(accountId)
}

export function isAccountReady(accountId: string): boolean {
  return readyAccounts.has(accountId)
}

export function getReadyAccountCount(): number {
  return readyAccounts.size
}

const accountLoad = new Map<string, number>()
let freeListeners: Array<() => void> = []

function emitAccountFreed(): void {
  if (freeListeners.length === 0) return
  const listeners = freeListeners
  freeListeners = []
  for (const resolve of listeners) resolve()
}

/** Called when a stream begins using an account slot. */
export function markAccountStreamStart(accountId: string): void {
  if (!accountId) return
  const base = getBaseAccountId(accountId) || accountId
  accountLoad.set(base, (accountLoad.get(base) ?? 0) + 1)
}

/** Called when a stream ends or fails; wakes a drained waiter. */
export function markAccountStreamEnd(accountId: string): void {
  if (!accountId) return
  const base = getBaseAccountId(accountId) || accountId
  const load = (accountLoad.get(base) ?? 1) - 1
  if (load <= 0) accountLoad.delete(base)
  else accountLoad.set(base, load)
  emitAccountFreed()
}

/** Active in-flight stream count for an account (lane-aware base bucket). */
export function getAccountActiveLoad(accountId?: string): number {
  if (!accountId) return 0
  const base = getBaseAccountId(accountId) || accountId
  return accountLoad.get(base) ?? 0
}

/** Resolves the next time any account slot frees (replaces blind polling). */
export function onAccountFreed(): { promise: Promise<void>; cancel: () => void } {
  let resolve: () => void
  const promise = new Promise<void>(r => { resolve = r })
  const entry = resolve!
  freeListeners.push(entry)
  return {
    promise,
    cancel: () => {
      const idx = freeListeners.indexOf(entry)
      if (idx !== -1) freeListeners.splice(idx, 1)
    },
  }
}

/**
 * Acquires one of the per-REAL-account concurrent stream slots, waiting up to
 * `timeoutMs` for a slot to free (signalled by `markAccountStreamEnd`). Every
 * lane of the same account shares a single bucket, so this caps concurrency
 * against the Qwen backend no matter how many lanes are configured — lanes
 * beyond the cap do not increase throughput, they only trigger 429s. Returns a
 * release function that must be called exactly once when the stream finishes.
 */
export async function acquireAccountStreamSlot(accountId: string, timeoutMs: number): Promise<() => void> {
  const base = getBaseAccountId(accountId) || accountId
  const limit = Math.max(1, getRuntimeInt('ACCOUNT_MAX_CONCURRENT_STREAMS', config.accounts.maxStreamsPerAccount))
  const waitStart = Date.now()

  for (;;) {
    const load = accountLoad.get(base) ?? 0
    if (load < limit) {
      markAccountStreamStart(base)
      let released = false
      return () => {
        if (released) return
        released = true
        markAccountStreamEnd(base)
      }
    }

    if (Date.now() - waitStart >= timeoutMs) {
      throw new RetryableQwenStreamError(
        `All ${limit} concurrent stream slot(s) for account ${base} are in use; timed out after ${timeoutMs}ms`,
        2000 + Math.floor(Math.random() * 1000),
      )
    }

    const freed = onAccountFreed()
    await Promise.race([
      new Promise(r => setTimeout(r, 500)),
      freed.promise,
    ])
    freed.cancel()
  }
}

export function getAccountById(accountId: string): QwenAccount | null {
  if (!accountId) return null;
  const accounts = getAccountsWithCooldownSync()
  return accounts.find(a => a.id === accountId) ?? null
}

export function getNextAccount(forceReset?: boolean): QwenAccount | null {
  const accounts = getAccountsWithCooldownSync()
  if (accounts.length === 0) {
    return null
  }

  if (forceReset) {
    currentIndex = 0
  }

  const viable: QwenAccount[] = []
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[currentIndex % accounts.length]
    currentIndex = (currentIndex + 1) % accounts.length
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      viable.push(account)
    }
  }

  if (viable.length > 0) {
    // Prefer ready lanes (context + headers already captured) so a request never
    // lands on a lane mid-warmup. But a lane whose cooldown just expired (or that
    // was on cooldown at startup) may not be marked ready yet — it is still safe
    // to select it, because downstream (header-interceptor) lazily creates its
    // context and marks it ready. Falling back to un-ready lanes is what lets an
    // account become available the moment its cooldown ends instead of staying
    // excluded forever while other accounts are ready.
    const readyViable = viable.filter(a => isAccountReady(a.id))
    const pool = readyViable.length > 0 ? readyViable : viable
    const minLoad = Math.min(...pool.map(a => getAccountActiveLoad(a.id)))
    const chosen = pool.find(a => getAccountActiveLoad(a.id) === minLoad)!
    currentIndex = (accounts.indexOf(chosen) + 1) % accounts.length
    return chosen
  }

  // Healthy accounts exist but are all busy (in-use): return null so the caller
  // waits for a lane to free instead of failing immediately on a cooldown
  // account. The cooldown fallback below must only apply when NO account is
  // healthy at all.
  const hasHealthyAccount = accounts.some(a => getAccountCooldownInfo(a.id) === null)
  if (hasHealthyAccount) {
    return null
  }

  if (config.accounts.singleAccountMode) {
    return null
  }

  // All accounts on cooldown — return the one with the shortest remaining cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getNextAvailableAccount(triedAccountIds?: Set<string> | string): QwenAccount | null {
  const accounts = getAccountsWithCooldownSync()
  if (accounts.length === 0) return null

  let triedSet: Set<string>
  if (triedAccountIds instanceof Set) {
    triedSet = triedAccountIds
  } else {
    triedSet = new Set(triedAccountIds ? [triedAccountIds] : [])
  }

  // 1. Try to find an untried account that is NOT on cooldown, preferring the
  // least-loaded one (ties keep round-robin order from currentIndex).
  const candidates: QwenAccount[] = []
  for (let i = 0; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length
    const account = accounts[idx]
    if (triedSet.has(account.id)) continue
    if (!isAccountOnCooldown(account.id) && !isAccountInUse(account.id)) {
      candidates.push(account)
    }
  }

  if (candidates.length > 0) {
    // Prefer ready lanes; only fall back to un-ready (e.g. cooldown-just-expired
    // or startup-cooldown) lanes when no ready candidate exists. They are safely
    // re-initialized on demand by the header interceptor.
    const readyCandidates = candidates.filter(a => isAccountReady(a.id))
    const pool = readyCandidates.length > 0 ? readyCandidates : candidates
    const minLoad = Math.min(...pool.map(a => getAccountActiveLoad(a.id)))
    const chosen = pool.find(a => getAccountActiveLoad(a.id) === minLoad)!
    currentIndex = (accounts.indexOf(chosen) + 1) % accounts.length
    return chosen
  }

  // Healthy untried accounts exist but are all in-use: return null so the
  // caller waits for a lane instead of falling through to a cooldown account.
  const hasHealthyAccount = accounts.some(a => !triedSet.has(a.id) && getAccountCooldownInfo(a.id) === null)
  if (hasHealthyAccount) {
    return null
  }

  if (config.accounts.singleAccountMode) {
    return null
  }

  // 2. If all untried accounts are on cooldown, return the untried one with the shortest remaining cooldown
  let best: QwenAccount | null = null
  let bestRemaining = Infinity
  for (const account of accounts) {
    if (triedSet.has(account.id)) continue
    const info = getAccountCooldownInfo(account.id)
    if (info && info.remainingMs < bestRemaining) {
      bestRemaining = info.remainingMs
      best = account
    }
  }
  return best
}

export function getAccountCount(): number {
  return getAccountsWithCooldownSync().length
}

export function getActiveAccountCount(): number {
  return getAccountsWithCooldownSync().filter(account => !isAccountOnCooldown(account.id)).length
}

export function getCooldownStatus(): Record<string, { remainingMs: number; reason: string }> {
  const result: Record<string, { remainingMs: number; reason: string }> = {}
  for (const [id, info] of cooldowns.entries()) {
    const remaining = info.until - Date.now()
    if (remaining > 0) {
      result[id] = { remainingMs: remaining, reason: info.reason }
    }
  }
  return result
}

export function getInUseAccounts(): string[] {
  return Array.from(inUseAccounts)
}
