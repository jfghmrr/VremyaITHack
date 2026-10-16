import { expect, test } from '@playwright/test';
import { fakeMic } from './fake-mic';
import { shoot } from './shoot';

test('документы закрываются в прежний раздел, друзья — отдельная вкладка', async ({page}) => {
  await page.goto('/songs');
  await page.getByRole('contentinfo').getByRole('link',{name:'Политика обработки данных'}).click();
  await expect(page.getByText('Команда mugsize',{exact:true})).toBeVisible();
  await expect(page.getByText('[не заполнено владельцем сайта]')).toHaveCount(0);
  await page.getByRole('navigation',{name:'Документы'}).first().getByRole('link',{name:'Согласие на обработку данных'}).click();
  await page.getByRole('link',{name:'Закрыть документы'}).click();
  await expect(page).toHaveURL(/\/songs$/);
  await page.getByRole('navigation',{name:'Основная навигация'}).getByRole('link',{name:'Друзья',exact:true}).click();
  await expect(page).toHaveURL(/\/friends$/);
  await page.goto('/legal/privacy');
  await page.reload();
  await page.getByRole('link',{name:'Закрыть документы'}).click();
  await expect(page).toHaveURL(/\/$/);
});

test('предупреждение записи можно закрыть, микрофон и заголовок не перекрываются',async({page,context})=>{
  await fakeMic(context,'cn-earth');
  await page.goto('/sing/cn-earth');
  await page.getByRole('button',{name:'Включить микрофон'}).click();
  await page.getByRole('button',{name:'Начать пение'}).click();
  await expect(page.getByLabel('Пение',{exact:true})).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.getByRole('alert')).toContainText('Запись прервана');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
  await shoot(page,'mic-warning',[[1366,768],[1920,1080],[800,768],[390,844]]);
  await page.getByRole('button',{name:'Закрыть предупреждение'}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Земное притяжение',exact:true})).toBeVisible();
  const meter=await page.getByRole('meter').boundingBox(),device=await page.locator('.device').boundingBox();
  expect(meter!.y).toBeGreaterThanOrEqual(device!.y);
  expect(meter!.y+meter!.height).toBeLessThanOrEqual(device!.y+device!.height);
  await page.getByRole('button',{name:'Включить микрофон'}).click();
  await expect(page.getByRole('button',{name:'Начать пение'})).toBeEnabled();
});

test('плеер результата действительно выдаёт запись и ориентир, показывает ход и стоп',async({page,context})=>{
  await fakeMic(context,'cn-earth',{shift:-5});
  await page.addInitScript(()=>{
    const w=window as unknown as {audioTaps:{context:BaseAudioContext;taps:AnalyserNode[]}[]};
    w.audioTaps=[];
    const original=AudioNode.prototype.connect;
    AudioNode.prototype.connect=function(this:AudioNode,destination:AudioNode,...args:number[]){
      const value=(original as Function).apply(this,[destination,...args]);
      if(destination instanceof AudioDestinationNode){
        let group=w.audioTaps.find(x=>x.context===this.context);
        if(!group){group={context:this.context,taps:[]};w.audioTaps.push(group);}
        const tap=this.context.createAnalyser();tap.fftSize=2048;
        (original as (destination: AudioNode) => AudioNode).call(this,tap);group.taps.push(tap);
      }
      return value;
    } as typeof original;
  });
  await page.goto('/sing/cn-earth');
  await page.getByRole('button',{name:'Включить микрофон'}).click();
  await page.getByRole('button',{name:'Начать пение'}).click();
  await expect(page).toHaveURL(/\/result$/,{timeout:40000});
  await page.getByRole('button',{name:'Как пел',exact:true}).click();
  const energy=()=>page.evaluate(()=>{
    const groups=(window as unknown as {audioTaps:{context:BaseAudioContext;taps:AnalyserNode[]}[]}).audioTaps;
    const g=groups.at(-1)!;
    return g.taps.slice(0,2).map(t=>{const v=new Float32Array(t.fftSize);t.getFloatTimeDomainData(v);return v.reduce((n,x)=>n+x*x,0)/v.length;});
  });
  await expect.poll(async()=> (await energy())[0]).toBeGreaterThan(.00001);
  await expect.poll(async()=>Number(await page.getByRole('progressbar',{name:'Воспроизведение записи'}).getAttribute('value'))).toBeGreaterThan(0.3);
  await page.getByRole('button',{name:'Ориентир',exact:true}).click();
  await expect.poll(async()=> (await energy())[1]).toBeGreaterThan(.000001);
  await expect.poll(async()=> (await energy())[0]).toBeLessThan(.000001);
  await page.getByRole('button',{name:'Остановить',exact:true}).click();
  await expect(page.getByRole('progressbar',{name:'Воспроизведение записи'})).toHaveAttribute('value','0');
  await page.getByRole('button',{name:'Слушать попытку'}).click();
  await expect(page.getByRole('button',{name:'Остановить',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Остановить',exact:true}).click();
  const closeAward = page.getByRole('button',{name:'Закрыть достижение'});
  if (await closeAward.isVisible()) await closeAward.click();
  await shoot(page,'result-polished',[[1366,768],[1920,1080],[800,768],[390,844]]);
  await page.getByRole('navigation',{name:'Основная навигация'}).getByRole('link',{name:'Мой прогресс',exact:true}).click();
  await page.getByRole('button',{name:'История исполнений'}).click();
  await expect(page.getByRole('region',{name:'Список попыток и матчей'}).getByText('Земное притяжение')).toBeVisible();
});
