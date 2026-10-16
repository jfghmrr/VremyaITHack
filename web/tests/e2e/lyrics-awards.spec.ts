import { expect, test } from '@playwright/test';
import { fakeMic } from './fake-mic';
import { shoot } from './shoot';
import { readFileSync } from 'node:fs';
import type { CatalogEntry } from '../../src/lib/catalog';

const catalog: CatalogEntry[] = JSON.parse(readFileSync(new URL('../../static/songs/index.json',import.meta.url),'utf8'));

test('русская песня: слова идут по аудио, пауза, результат и достижение', async ({page,context}) => {
  const song=catalog.find(entry=>entry.id==='cn-earth')!;
  expect(song?.hasVocals).toBe(true);
  await fakeMic(context,song.id,{shift:5});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/songs');
  await page.getByRole('button',{name:'Русские',exact:true}).click();
  await expect(page.locator('.song')).toHaveCount(catalog.filter(entry=>entry.language==='ru').length);
  await page.getByRole('searchbox').fill(song.title);
  await page.locator('.song').filter({hasText:song.title}).click();
  await page.getByRole('button',{name:`Петь «${song.title}»`}).click();
  await page.getByRole('button',{name:'Включить микрофон'}).click();
  await page.getByRole('button',{name:'Начать пение'}).click();
  await expect(page.locator('.active-word').first()).toBeVisible({timeout:10000});
  await page.getByRole('button',{name:'Пауза',exact:true}).click();
  await expect(page.getByRole('button',{name:'Продолжить',exact:true})).toBeVisible();
  // Пауза может совпасть с границей двух слов. Проверяем неподвижность всей
  // разметки, даже если в этот момент нет одного активного слова.
  const fill=await page.locator('.word').evaluateAll(words=>words.map(word=>word.getAttribute('style')));
  await page.waitForTimeout(600);
  expect(await page.locator('.word').evaluateAll(words=>words.map(word=>word.getAttribute('style')))).toEqual(fill);
  await shoot(page,'karaoke-words',[[1366,768],[1920,1080],[800,768]]);
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await expect(page).toHaveURL(/\/result$/, {timeout:80000});
  await expect(page.getByLabel('Получено достижение')).toContainText('Первая песня');
  await page.getByRole('button',{name:'Звук достижений'}).click();
  await expect(page.getByRole('button',{name:'Звук достижений'})).toHaveAttribute('aria-pressed','false');
  await page.screenshot({path:'../docs/screens/achievement-1366.png'});
  const score = await page.getByLabel(/из 100/).getAttribute('aria-label');
  expect(Number(score!.split(' ')[0])).toBeGreaterThan(90);
  await page.getByRole('button',{name:'Закрыть достижение'}).click();
  await page.reload();
  await page.goto('/');
  expect(await page.evaluate(()=>localStorage.getItem('perepev.awards.guest'))).toContain('first');
  await expect(page.getByLabel('Получено достижение')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('две песни учитываются отдельно от нулевой рейтинговой калибровки',async({page})=>{
  await page.route('**/api/me',route=>route.fulfill({json:{profile:{id:'test-profile',name:'Музыкальный кот',email:'test@example.test'},rating:{calibrating:true,calibrationTotal:10,mmr:1000,protected:true,rank:null,ratedMatches:0}}}));
  const attempts=['kalinka-words','berezka-words'].map((songId,i)=>({id:String(i),at:new Date().toISOString(),songId,title:i?'Во поле берёза стояла':'Калинка',score:85,shift:5,axes:{intervals:.9,rhythm:.8,stability:.9,coverage:1},moments:[]}));
  await page.route('**/api/attempts',route=>route.fulfill({json:{attempts}}));
  await page.route('**/api/matches',route=>route.fulfill({json:{matches:[]}}));
  await page.goto('/progress');
  await expect(page.getByText('2 песни · 2 попытки')).toBeVisible();
  await page.getByRole('button',{name:'История исполнений'}).click();
  await expect(page.getByText('Спето песен: 2')).toBeVisible();
  await expect(page.getByText('Рейтинговые дуэли: 0 из 10')).toBeVisible();
  await shoot(page,'progress-counters',[[1366,768],[1920,1080],[800,768],[390,844]]);
});

test('длинное название и тихие эффекты: макет и доступность',async({page})=>{
  await page.goto('/songs');
  const song=catalog.find(entry=>entry.id==='jw-i-will-not-let-you-let-me-down')!;
  expect(song?.hasVocals).toBe(true);
  await page.getByRole('searchbox').fill(song.title);
  await page.locator('.song').first().click();
  await expect(page.locator('.label-strip strong')).toHaveText(song.title);
  await shoot(page,'song-long-title',[[1366,768],[1920,1080],[800,768],[390,844]]);
  await page.goto('/duels'); await shoot(page,'duels-heading',[[1366,768],[800,768]]);
  await page.goto('/leaders'); await shoot(page,'leaders-poster',[[1366,768],[800,768]]);
  await page.mouse.move(100,100); await page.mouse.move(300,200,{steps:10});
  await expect(page.locator('.sparkles')).toHaveCSS('pointer-events','none');
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('.sparkles')).toBeHidden();
});
