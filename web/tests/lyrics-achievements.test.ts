import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseWordTiming, isCurrentWord, wordProgress } from '../src/lib/lyrics';
import { achievementsOf, newlyEarned } from '../src/lib/achievements';
import type { Song } from '../src/lib/scoring/types';

for (const id of ['kalinka-words','berezka-words']) {
  const base = new URL(`../static/songs/${id}/`, import.meta.url);
  const song: Song = JSON.parse(readFileSync(new URL('reference.json',base),'utf8'));
  const raw = JSON.parse(readFileSync(new URL('lyrics.words.json',base),'utf8'));
  it(`${id}: каждое слово совпадает с текстом и попадает в голосовую фразу`, () => {
    const timing = parseWordTiming(raw,song);
    for (const line of timing.lines) for (const w of line.words) {
      const start = Math.round(w.start_s * 100);
      expect(song.f0_midi[start]).not.toBeNull();
      expect(isCurrentWord(w,w.start_s)).toBe(true);
      expect(isCurrentWord(w,w.end_s)).toBe(false);
      expect(wordProgress(w,(w.start_s+w.end_s)/2)).toBeCloseTo(.5);
    }
    expect(() => parseWordTiming({...raw,lines:[]},song)).toThrow();
    const broken = structuredClone(raw); broken.lines[0].words[1].start_s = 0;
    expect(() => parseWordTiming(broken,song)).toThrow();
  });
}
it('пауза между словами не подсвечивает следующее слово раньше времени', () => {
  const w = {text:'Привет',start_s:2,end_s:3};
  expect(isCurrentWord(w,1.9)).toBe(false); expect(wordProgress(w,1.9)).toBe(0);
  expect(isCurrentWord(w,3.1)).toBe(false); expect(wordProgress(w,3.1)).toBe(1);
});
it('достижения выдаются только за новые результаты, победа не засчитывается в незавершённой дуэли', () => {
  const empty = achievementsOf([],[]), first = achievementsOf([{songId:'a',score:87}],[]);
  expect(newlyEarned(empty,first).map(a=>a.id)).toEqual(['first','clean']);
  expect(newlyEarned(first,first)).toEqual([]);
  const next = achievementsOf(['a','a','b','c','c'].map(songId=>({songId,score:20})),[{state:'aborted',outcome:'win'}]);
  expect(next.filter(a=>a.got).map(a=>a.id)).toEqual(['first','five','songs']);
  expect(achievementsOf([],[{state:'finished',outcome:'win'}]).filter(a=>a.got).map(a=>a.id)).toEqual(['duel','win']);
});

it('«Вместе» — не дуэль с соперником: «Первая дуэль» и «Победа в дуэли» за неё не выдаются', () => {
  const coop = achievementsOf([], [{ state: 'finished', outcome: 'draw', mode: 'coop' }]);
  expect(coop.filter(a => a.got).map(a => a.id)).toEqual([]);
  // Дуэль «Кто лучше» с другом по-прежнему считается.
  const versus = achievementsOf([], [{ state: 'finished', outcome: 'draw', mode: 'versus' }]);
  expect(versus.filter(a => a.got).map(a => a.id)).toEqual(['duel']);
});
