import { achievementsOf, newlyEarned, type Achievement, type AchievementAttempt, type AchievementMatch } from "./achievements";
import { api } from "./api/http";
import { account } from "./api/account.svelte";

export const awards = $state<{ queue: Achievement[]; sound: boolean }>({ queue: [], sound: true });
const known = new Map<string, Achievement[]>();
const key = () => account.profile?.id ?? "guest";

export function updateAchievements(attempts: AchievementAttempt[], matches: AchievementMatch[], announce = true) {
  const who = key(), next = achievementsOf(attempts, matches);
  const previous = known.get(who) ?? achievementsOf([], []);
  let seen: string[] = [];
  try { const stored: unknown = JSON.parse(localStorage.getItem(`perepev.awards.${who}`) ?? "[]"); if (Array.isArray(stored)) seen = stored.filter((id): id is string => typeof id === "string"); } catch { /* storage optional */ }
  if (announce) awards.queue.push(...newlyEarned(previous, next).filter(a => !seen.includes(a.id) && !awards.queue.some(q => q.id === a.id)));
  known.set(who, next);
  try { localStorage.setItem(`perepev.awards.${who}`, JSON.stringify([...new Set([...seen, ...next.filter(a => a.got).map(a => a.id)])])); } catch { /* session deduplication remains */ }
}

export async function refreshAchievements(announce = true) {
  const owner = account.profile?.id;
  if (!owner) return;
  try {
    const [a, m] = await Promise.all([api<{attempts: AchievementAttempt[]}>("attempts"), api<{matches: AchievementMatch[]}>("matches")]);
    if (account.profile?.id === owner) updateAchievements(a.attempts, m.matches, announce);
  } catch { /* an achievement must not interfere with saving or singing */ }
}
