<script lang="ts">
  import { onMount } from "svelte";
  import { awards } from "#lib/achievements.svelte.ts";
  import Pin from "#lib/brand/Pin.svelte";
  let audio: AudioContext | null = null;
  const current = $derived(awards.queue[0]);
  onMount(() => {
    try { awards.sound = localStorage.getItem("perepev.awards.sound") !== "off"; } catch { /* default on */ }
    const unlock = () => {
      if (!awards.sound) return;
      audio ??= new AudioContext();
      void audio.resume().catch(() => {});
    };
    addEventListener("pointerdown", unlock); addEventListener("keydown", unlock);
    return () => { removeEventListener("pointerdown", unlock); removeEventListener("keydown", unlock); void audio?.close(); };
  });
  function toggleSound() {
    awards.sound = !awards.sound;
    try { localStorage.setItem("perepev.awards.sound", awards.sound ? "on" : "off"); } catch { /* optional */ }
  }
  $effect(() => {
    const id = current?.id;
    if (!id) return;
    // A short original three-note chime; no Steam recordings or third-party audio.
    if (awards.sound && audio?.state === "running") {
      const ctx = audio;
      [523.25,659.25,783.99].forEach((f,i) => {
        const t=ctx.currentTime+i*.1, osc=ctx.createOscillator(), gain=ctx.createGain();
        osc.type="sine";osc.frequency.value=f;gain.gain.setValueAtTime(0,t);gain.gain.linearRampToValueAtTime(.045,t+.012);gain.gain.exponentialRampToValueAtTime(.001,t+.42);
        osc.connect(gain).connect(ctx.destination);osc.start(t);osc.stop(t+.44);
        osc.onended=()=>{osc.disconnect();gain.disconnect();};
      });
    }
    const timer=setTimeout(()=>{if(awards.queue[0]?.id===id) awards.queue.shift();},6000);
    return ()=>clearTimeout(timer);
  });
</script>
<div class="toast-region" role={current ? "status" : undefined} aria-live="polite" aria-atomic="true">
  {#if current}{#key current.id}
    <aside class="achievement-toast" aria-label="Получено достижение">
      <Pin kind="bolt" size={48} />
      <div><span class="eyebrow">Достижение получено</span><strong>{current.label}</strong><p>{current.description}</p></div>
      <button class="close" aria-label="Закрыть достижение" onclick={()=>awards.queue.shift()}>×</button>
      <button class="sound" aria-pressed={awards.sound} aria-label="Звук достижений" onclick={toggleSound}>{awards.sound ? "♪ Звук включён" : "Звук выключен"}</button>
    </aside>
  {/key}{/if}
</div>
<style>
  .toast-region{position:fixed;bottom:calc(24px + var(--safe-bottom));right:calc(24px + var(--safe-right));z-index:1000;pointer-events:none;max-width:calc(100vw - 32px - var(--safe-left) - var(--safe-right))}
  .achievement-toast{position:relative;display:grid;grid-template-columns:48px 1fr;gap:12px;width:360px;max-width:100%;padding:18px 34px 34px 18px;background:#252723;color:var(--paper);border:1px solid #8d876d;border-left:5px solid #ad3833;box-shadow:0 8px 30px #0008;pointer-events:auto;animation:arrive .35s ease-out}
  .eyebrow{font:10px var(--font-mono);text-transform:uppercase;color:#c8bba3}strong{display:block;font:700 26px/1.2 var(--font-hand)}p{font-size:12px;margin:4px 0 0;color:#cfc4b0}
  button{border:0;background:none;color:inherit;padding:2px 7px}.close{position:absolute;right:6px;top:4px;font-size:24px}.sound{position:absolute;right:10px;bottom:7px;font-size:10px;color:#cfc4b0}
  @keyframes arrive{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  @media(prefers-reduced-motion:reduce){.achievement-toast{animation:none}}
  /* Сенсорный экран: крестик и звук не меньше 44 px, над полоской «домой». */
  @media (pointer: coarse){.toast-region{bottom:calc(16px + var(--safe-bottom));right:calc(16px + var(--safe-right))}.achievement-toast{padding:18px 48px 48px 18px}.close,.sound{min-width:44px;min-height:44px}.close{right:0;top:0}.sound{right:2px;bottom:2px}}
  /* Телефон с нижним меню: достижение над ним (--bar-space задаёт routes/+layout.svelte). */
  @media (max-width: 599px), (max-width: 799px) and (min-height: 521px){.toast-region{bottom:calc(16px + var(--bar-space, var(--safe-bottom)))}}
</style>
