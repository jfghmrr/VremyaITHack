import { expect, test, type Page } from '@playwright/test';
import { player } from './helpers';
import { shoot } from './shoot';

const call = (p: Page, path: string, method = 'GET', body: unknown = {}) => p.evaluate(async ({path,method,body}) => {
  const r = await fetch(`/api/${path}`, {method, headers: method === 'GET' ? {} : {'content-type':'application/json','x-perepev-request':'1'}, body: method === 'GET' ? undefined : JSON.stringify(body)});
  return {status:r.status, data:await r.json()};
}, {path,method,body});

test('друзья: заявка, подтверждение, приватность, сохранение и удаление', async ({browser}) => {
  const a = await player(browser,'Маша','cn-earth',{}), b = await player(browser,'Саша','cn-earth',{}), c = await player(browser,'Наблюдатель','cn-earth',{});
  try {
    for (const p of [a.page,b.page,c.page]) await p.goto('/friends');
    const aid = await a.page.getByLabel('Мой код',{exact:true}).inputValue();
    const bid = await b.page.getByLabel('Мой код',{exact:true}).inputValue();
    await a.page.getByRole('button',{name:'Скопировать код'}).click();
    await expect(a.page.getByRole('status')).toHaveText('Код скопирован');
    expect(await a.page.evaluate(()=>navigator.clipboard.readText())).toBe(aid);
    await a.page.getByLabel('Код друга',{exact:true}).fill('не код');
    await a.page.getByRole('button',{name:'Отправить заявку'}).click();
    await expect(a.page.getByRole('alert')).toContainText('Вставь код целиком');
    expect((await call(a.page,'friends','POST',{id:aid})).status).toBe(400);
    expect((await call(a.page,'friends','POST',{id:'00000000-0000-4000-8000-000000000001'})).status).toBe(404);
    await a.page.getByLabel('Код друга',{exact:true}).fill(bid);
    await a.page.getByRole('button',{name:'Отправить заявку'}).click();
    await expect(a.page.getByRole('status')).toContainText('Заявка отправлена');
    expect((await call(a.page,`friends/${bid}/accept`,'POST')).status).toBe(404);
    expect((await call(c.page,`friends/${aid}/accept`,'POST')).status).toBe(404);
    expect((await call(c.page,'friends')).data).toEqual({friends:[],incoming:[],outgoing:[]});
    // Повторная и встречная заявки не принимают дружбу без подтверждения.
    await call(a.page,'friends','POST',{id:bid});
    const crossed = await call(b.page,'friends','POST',{id:aid});
    expect(crossed.data.incoming).toEqual([{id:aid,name:'Маша'}]);
    expect(crossed.data.friends).toEqual([]);
    await b.page.getByRole('button',{name:'Обновить',exact:true}).click();
    await b.page.getByRole('button',{name:/Заявки · 1/}).click();
    await b.page.getByRole('button',{name:'Принять',exact:true}).click();
    await expect(b.page.getByRole('status')).toContainText('Маша теперь в друзьях');
    for (const p of [a.page,b.page]) { await p.reload(); await expect(p.locator('.person')).toHaveCount(1); }
    const friends = (await call(a.page,'friends')).data;
    expect(friends.friends).toEqual([{id:bid,name:'Саша'}]);
    expect(JSON.stringify(friends)).not.toContain(b.email);
    expect((await call(a.page,'me/export')).data.friends).toEqual(friends);
    await shoot(a.page,'friends-final',[[1366,768],[1920,1080],[800,768],[390,844]]);
    await a.page.goto('/');
    const locker = a.page.getByRole('group',{name:'Шкафчик «Друзья»'});
    await locker.hover(); await expect(locker).toContainText('Саша');
    await a.page.goto('/friends');
    await a.page.getByRole('button',{name:'Удалить из друзей: Саша'}).click();
    await a.page.getByRole('dialog').getByRole('button',{name:/^Удалить/}).click();
    await expect(a.page.getByText('Здесь будут твои друзья')).toBeVisible();
    expect((await call(b.page,'friends')).data.friends).toEqual([]);
    // Отказ, отмена и удаление кабинета чистят связи у обеих сторон.
    await call(a.page,'friends','POST',{id:bid});
    await call(b.page,`friends/${aid}`,'DELETE');
    expect((await call(a.page,'friends')).data.outgoing).toEqual([]);
    await call(a.page,'friends','POST',{id:bid});
    expect((await call(b.page,'me/delete','POST',{password:'Long-demo-pass-2026'})).status).toBe(200);
    expect((await call(a.page,'friends')).data).toEqual({friends:[],incoming:[],outgoing:[]});
  } finally { await Promise.all([a.context.close(),b.context.close(),c.context.close()]); }
});

test('друзья: гость не видит адресную книгу; два разных кота на лидерах', async ({page}) => {
  await page.goto('/friends');
  await expect(page.getByRole('heading',{name:'Вместе интереснее'})).toBeVisible();
  expect((await call(page,'friends')).status).toBe(401);
  await page.goto('/leaders');
  await expect(page.locator('.polaroid .cat img')).toHaveCount(2);
  const images = await page.locator('.polaroid .cat img').evaluateAll(imgs=>imgs.map(e=>e.getAttribute('src')));
  expect(new Set(images).size).toBe(2);
  expect(images.some(i=>i?.includes('paw-up'))).toBe(false);
  await shoot(page,'leaders-two-cats',[[1366,768],[1920,1080],[800,768],[390,844]]);
});
