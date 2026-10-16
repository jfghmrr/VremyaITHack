export type Achievement = { id: string; label: string; description: string; icon: string; got: boolean };
export type AchievementAttempt = { songId: string; score: number };
export type AchievementMatch = { state: string; outcome: string | null };

export function achievementsOf(attempts: AchievementAttempt[], matches: AchievementMatch[]): Achievement[] {
  return [
    { id: "first", label: "Первая песня", description: "Начало твоей музыкальной истории", got: attempts.length >= 1, icon: "star" },
    { id: "five", label: "Пять попыток", description: "Пять выходов к микрофону", got: attempts.length >= 5, icon: "tape" },
    { id: "clean", label: "Чисто: 85+", description: "Исполнение на 85 баллов или выше", got: attempts.some(a => a.score >= 85), icon: "cat" },
    { id: "songs", label: "Три разные песни", description: "Твой репертуар становится шире", got: new Set(attempts.map(a => a.songId)).size >= 3, icon: "mic" },
    { id: "duel", label: "Первая дуэль", description: "Спел вместе с живым соперником", got: matches.some(m => m.state === "finished"), icon: "vs" },
    { id: "win", label: "Победа в дуэли", description: "Первый победный выход на сцену", got: matches.some(m => m.state === "finished" && m.outcome === "win"), icon: "print" },
  ];
}

export function newlyEarned(before: Achievement[], after: Achievement[]) {
  const earned = new Set(before.filter(a => a.got).map(a => a.id));
  return after.filter(a => a.got && !earned.has(a.id));
}
