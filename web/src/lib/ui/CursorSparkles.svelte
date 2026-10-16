<script lang="ts">
  import { onMount } from "svelte";
  let canvas: HTMLCanvasElement;
  onMount(() => {
    const ctx=canvas.getContext("2d"); if(!ctx) return;
    const motion=matchMedia("(prefers-reduced-motion: reduce)"),fine=matchMedia("(pointer: fine)");
    let raf=0,last=0,w=innerWidth,h=innerHeight,dpr=1;
    const particles:{x:number;y:number;born:number;size:number;drift:number}[]=[];
    function resize(){w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio||1,2);canvas.width=w*dpr;canvas.height=h*dpr;}
    function draw(now:number){
      raf=0;ctx!.setTransform(dpr,0,0,dpr,0,0);ctx!.clearRect(0,0,w,h);
      for(let i=particles.length-1;i>=0;i--){const p=particles[i],age=(now-p.born)/650;if(age>=1){particles.splice(i,1);continue;}
        ctx!.save();ctx!.translate(p.x+p.drift*age,p.y+20*age);ctx!.rotate(age);ctx!.globalAlpha=(1-age)*.65;ctx!.fillStyle=i%2?"#d5ba7a":"#efe6d2";ctx!.beginPath();
        for(let k=0;k<8;k++){const a=k*Math.PI/4,r=k%2?p.size*.25:p.size;const x=Math.cos(a)*r,y=Math.sin(a)*r;k?ctx!.lineTo(x,y):ctx!.moveTo(x,y);}ctx!.closePath();ctx!.fill();ctx!.restore();
      }
      if(particles.length)raf=requestAnimationFrame(draw);
    }
    const move=(e:PointerEvent)=>{const now=performance.now();if(motion.matches||!fine.matches||e.pointerType!=="mouse"||now-last<38||document.hidden)return;last=now;particles.push({x:e.clientX-5,y:e.clientY+8,born:now,size:2+Math.random()*3,drift:(Math.random()-.5)*28});if(particles.length>20)particles.shift();if(!raf)raf=requestAnimationFrame(draw);};
    resize();addEventListener("resize",resize);addEventListener("pointermove",move,{passive:true});
    return()=>{cancelAnimationFrame(raf);removeEventListener("resize",resize);removeEventListener("pointermove",move);};
  });
</script>
<canvas bind:this={canvas} class="sparkles" aria-hidden="true"></canvas>
<style>.sparkles{position:fixed;inset:0;width:100%;height:100%;z-index:2000;pointer-events:none}@media(prefers-reduced-motion:reduce),(pointer:coarse){.sparkles{display:none}}</style>
