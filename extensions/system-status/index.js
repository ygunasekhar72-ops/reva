// Sample mobile extension for the REVA PWA. Loaded by app.js via dynamic
// import; gets a restricted registration API (cards, commands, fetch).
export function activate(reva) {
  reva.registerCard({
    title: 'system status',
    render(el) {
      const online = navigator.onLine;
      const conn = navigator.connection
        ? `${navigator.connection.effectiveType ?? 'unknown'} (${navigator.connection.downlink ?? '?'}Mb/s)`
        : 'n/a';
      const battery = navigator.getBattery
        ? 'checking…'
        : (navigator.battery ? `${Math.round(navigator.battery.level * 100)}%` : 'n/a');
      el.innerHTML = `
        <div>network: ${online ? 'online' : 'offline'} · ${conn}</div>
        <div>screen: ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x</div>
        <div>cores: ${navigator.hardwareConcurrency ?? '?'} · memory: ${(navigator.deviceMemory ?? navigator.deviceMemory) ?? '?'}GB</div>
        <div class="dim">REVA extension API v${reva.version}</div>`;
      if (navigator.getBattery) {
        navigator.getBattery().then((b) => {
          el.querySelector('.dim')?.insertAdjacentHTML('beforebegin', `<div>battery: ${Math.round(b.level * 100)}%${b.charging ? ' charging' : ''}</div>`);
        }).catch(() => {});
      }
    },
  });

  reva.addCommand({
    name: 'list-tools',
    label: 'list agent tools',
    async run(api) {
      const data = await api.fetch('/api/tools');
      api.notify(`tools: ${data.tools.map((t) => t.name).join(', ')}`);
    },
  });
}
