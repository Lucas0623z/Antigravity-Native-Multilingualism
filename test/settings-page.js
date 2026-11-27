'use strict';
/** 模拟 Antigravity 设置页（结构取自真实界面的 class / data-testid） */
const CHEVRON = '<svg width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" class="w-3 h-3 shrink-0 opacity-70 ml-1"><path d="M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z"></path></svg>';

function selectRow(title, desc, value, id) {
  return `
  <div class="py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center">
    <div class="flex-1 flex flex-col gap-0.5">
      <div class="flex items-center gap-1.5"><span>${title}</span></div>
      <span class="text-sm text-muted-foreground whitespace-pre-wrap">${desc}</span>
    </div>
    <div class="shrink-0 relative">
      <button id="radix-${id}" type="button" role="combobox" aria-controls="radix-${id}-content" aria-expanded="false" data-state="closed"
        class="agy-select-trigger appearance-none px-2.5 py-1 bg-secondary text-secondary-foreground rounded-md border-none cursor-pointer flex items-center gap-2 justify-between min-w-[185px]">
        <span class="truncate">${value}</span>${CHEVRON}
      </button>
    </div>
  </div>`;
}

function switchRow(title, desc) {
  return `
  <div class="py-2 px-3 w-full bg-transparent flex justify-between gap-4 items-center">
    <div class="flex-1 flex flex-col gap-0.5"><div class="flex items-center gap-1.5"><span>${title}</span></div>
      <span class="text-sm text-muted-foreground">${desc}</span></div>
    <button type="button" role="switch" aria-checked="true" class="agy-switch"></button>
  </div>`;
}

const SETTINGS_HTML = `<!doctype html><html><head></head><body style="font-family: Inter, system-ui">
<nav><button>Settings</button><button title="Close">x</button></nav>
<main class="max-w-2xl">
  <h2>Settings</h2>
  <div class="flex flex-col gap-8">
    <div class="space-y-2" id="general">
      <div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 font-medium">General</h3></div></div></div>
      <div><div class="agy-card bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border">
        ${switchRow('Telemetry', 'Help improve Antigravity')}
        ${switchRow('Notifications', 'Get notified when the agent needs your attention or completes a task.')}
      </div></div>
    </div>
    <div class="space-y-2" id="appearance">
      <div class="flex flex-col gap-1"><div class="flex items-center justify-between"><div class="flex items-center gap-1.5"><h3 class="m-0 font-medium">Appearance</h3></div></div></div>
      <div><div class="agy-card bg-transparent rounded-xl border border-border overflow-hidden divide-y divide-border" id="appearance-card">
        ${selectRow('Theme', 'Choose a color theme', 'Dark', 1)}
        ${selectRow('Font size', 'Size of the interface text', '14', 2)}
      </div></div>
    </div>
  </div>
  <div class="prose"><h3>Settings</h3><p>Read the README and fix the bug</p></div>
  <div data-testid="user-message-content">Settings</div>
  <pre><code>Settings</code></pre>
  <p class="desc">Cancel</p>
  <p class="sentence">Running npm test</p>
  <div class="step">Running npm test</div>
  <input id="search" placeholder="Search" />
  <div data-testid="conversation-row-sidebar"><a href="/c/1"><span class="truncate">Settings</span></a></div>
</main>
</body></html>`;

module.exports = { SETTINGS_HTML, selectRow };
