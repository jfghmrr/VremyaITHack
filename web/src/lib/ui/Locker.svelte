<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  let { label, href, tone = "green", children }: { label: string; href: string; tone?: "red" | "black" | "cream" | "green"; children: Snippet } = $props();
  let hovered = $state(false), focused = $state(false);
  const open = $derived(hovered || focused);
  let leaveTimer: ReturnType<typeof setTimeout>;
  const uid = $props.id();
  function enter(e: PointerEvent) {
    if (e.pointerType === "touch") return;
    clearTimeout(leaveTimer); hovered = true;
  }
  function leave() { leaveTimer = setTimeout(() => hovered = false, 240); }
  onDestroy(() => clearTimeout(leaveTimer));
</script>
<div class="locker {tone}" role="group" aria-label="Шкафчик «{label}»" class:open onpointerenter={enter} onpointerleave={leave} onfocusin={() => focused = true} onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focused = false; }}>
  <a class="door" {href} aria-label="{label} — открыть раздел" aria-expanded={open} aria-controls="{uid}-inside">
    <span class="face" aria-hidden="true">
      <span class="vents top">{#each [0,1,2,3] as vent (vent)}<i></i>{/each}</span>
      <span class="tag">{label}</span>
      <span class="handle"></span>
      <svg class="sticker" viewBox="0 0 80 80"><path d="M40 5 49 28 74 30 55 47 60 72 40 58 18 72 24 47 5 30 31 28Z" fill="#e8dfc9" stroke="#261f19" stroke-width="2"/><path d="m40 17 3 23 18-8-21 18-9 11 4-25 16 18-26-15 25 2Z" fill="none" stroke="#261f19" stroke-width="2.5" stroke-linejoin="round"/></svg>
      <span class="vents bottom">{#each [0,1,2,3] as vent (vent)}<i></i>{/each}</span>
      <span class="screw one"></span><span class="screw two"></span><span class="screw three"></span><span class="screw four"></span>
    </span>
    <span class="back" aria-hidden="true"></span>
    <span class="edge" aria-hidden="true"></span>
  </a>
  <div class="body">
    <div class="inside" id="{uid}-inside" inert={!open}>
      {@render children()}
    </div>
  </div>
</div>
<style>
  /* Дверца — настоящий элемент интерфейса, как в perepev-locker.html.
     Рёбра, ручка, вентиляция и наклейка не зависят от разрешения растровой вырезки. */
  .locker { --metal: #434b3b; --shine: #727965; --shade: #232b22; position: relative; perspective: 1200px; perspective-origin: 100% 50%; isolation: isolate; width: 100%; height: 100%; min-height: 220px; }
  .red { --metal: #842924; --shine: #b3624e; --shade: #4b1c1a; }
  .black { --metal: #30302c; --shine: #67675e; --shade: #191b19; }
  .cream { --metal: #b9aa87; --shine: #e3d6b4; --shade: #6d624d; }
  .body { position: absolute; inset: 1%; background: linear-gradient(90deg,#0e100d,#34342a 65%,#0c0d0b); border: 4px solid var(--shade); border-radius: 3px; box-shadow: inset 0 0 0 2px var(--shine), inset 6px 3px 18px #0009, 0 7px 9px #0006; }
  .inside { position: absolute; inset: 0; padding: 18px 10px; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 9px; background: var(--paper) var(--tex-paper); color: var(--ink); font-size: clamp(12px,1cqi,15px); line-height: 1.35; text-align: center; opacity: 0; transition: opacity 150ms ease; box-shadow: 1px 3px 5px #0006; }
  .open .inside { opacity: 1; transition-delay: 270ms; }
  .door { position: absolute; z-index: 2; inset: 0; padding: 0; border: 0; border-radius: 4px; background: var(--shade); transform-origin: 100% center; transform-style: preserve-3d; transition: transform 750ms var(--ease-heavy); }
  .open .door { transform: rotateY(87deg); }
  .back { position: absolute; inset: 0; border: 4px solid var(--shine); border-radius: 4px; background: linear-gradient(100deg,#ffffff0b,#0004), repeating-linear-gradient(172deg,transparent 0 57px,#dbc49c0c 58px,transparent 59px 103px),var(--metal); box-shadow: inset 0 0 0 2px var(--shade), inset 0 0 0 9px var(--metal), inset 0 0 0 10px #0005; transform: rotateY(180deg); backface-visibility: hidden; }
  .door:focus-visible { outline: 3px solid var(--paper); outline-offset: 4px; }
  /* z-index: WebKit (Safari) рисует развёрнутую .back поверх лицевой стороны, не скрывая её
     изнанку; лицевая сторона явно выше. Изнанка видна только при развороте дверцы дальше 90°. */
  .face { position: absolute; z-index: 1; inset: 0; border: 3px solid var(--shade); border-radius: 4px; box-shadow: inset 0 0 0 1px var(--shine), inset 0 0 0 7px var(--metal), inset 0 0 0 8px #180e0d99, 2px 4px 8px #0005; background: linear-gradient(100deg,#ffffff12,transparent 24%,#0002 75%), repeating-linear-gradient(172deg, transparent 0 39px,#dfc6a017 40px,transparent 41px 67px), var(--metal); backface-visibility: hidden; }
  .vents { position: absolute; left: 24%; right: 23%; display: grid; gap: 5px; }
  .vents.top { top: 10%; } .vents.bottom { bottom: 10%; }
  .vents i { display: block; height: 5px; border-radius: 2px; background: linear-gradient(var(--shade) 0 45%,var(--metal) 55%); box-shadow: 0 1px 0 var(--shine),0 -1px 0 #0005; }
  .handle { position: absolute; left: 12%; top: 48%; height: 19%; width: 9%; min-width: 6px; border-radius: 3px; border: 1px solid #1b1b18; background: linear-gradient(90deg,#33352f,#b0aca0 30%,#e0dac8 47%,#5e6157 75%,#252b25); box-shadow: 2px 2px 2px #0009; }
  .handle::after { content: ''; position: absolute; left: 35%; top: 12%; height: 75%; width: 30%; background: #30362e; border-radius: 2px; }
  .edge { position: absolute; left: 0; top: 1%; height: 98%; width: 5px; background: var(--shine); transform: rotateY(-90deg); transform-origin: left; }
  .tag { position: absolute; top: 28%; left: 8%; width: 84%; padding: 6px 3px; color: var(--ink); background: var(--paper) var(--tex-paper); font: 700 clamp(16px,1.6vw,25px)/1 var(--font-hand); rotate: -4deg; box-shadow: 0 2px 3px #0006; }
  .tag::before { content: ''; position: absolute; width: 32px; height: 12px; top: -7px; left: 30%; background: #e5d9b780; rotate: 8deg; }
  .sticker { position: absolute; top: 61%; right: 13%; width: 37%; rotate: 12deg; }
  .screw { position: absolute; width: 3px; height: 3px; border-radius: 50%; background: #a59a83; box-shadow: 0 1px 1px #000a; }
  .one { left: 4%; top: 2%; } .two { right: 4%; top: 2%; } .three { left: 4%; bottom: 2%; } .four { right: 4%; bottom: 2%; }
  .inside :global(a) { color: var(--accent); font-weight: 700; text-underline-offset: 3px; }
  .inside :global(.cat) { max-width: 80%; }
  @media (prefers-reduced-motion: reduce) { .door, .inside { transition: none; } }
</style>
