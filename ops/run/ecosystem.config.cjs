// PM2 process list for running VeeTrax publicly at https://us.veetrax.com from this Windows PC.
// Start / reload:  pm2 start ops/run/ecosystem.config.cjs && pm2 save
// Status / logs:   pm2 ls   |   pm2 logs [name]   |   pm2 restart all
// Everything runs hidden; PM2 restarts any process that exits.
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..', '..');
const api = path.join(root, 'apps', 'api');
const web = path.join(root, 'apps', 'web');
const cloudflared = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';
const tunnelConfig = path.join(os.homedir(), '.cloudflared', 'veetrax.yml');

const node = (name, script) => ({
  name,
  cwd: api,
  script,
  windowsHide: true,
  restart_delay: 3000, // e.g. while WSL (PostgreSQL / Valkey) is still booting
  max_memory_restart: '1500M',
  // Production safety assertions + SSRF guards (risk R-02, decision Q-02; validated on staging 2026-11-09).
  env: { NODE_ENV: 'production' },
});

module.exports = {
  apps: [
    // Keeps WSL Ubuntu (PostgreSQL + Valkey systemd services) from idling out.
    {
      name: 'wsl-db',
      script: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '-u', 'root', '-e', 'sleep', 'infinity'],
      interpreter: 'none',
      windowsHide: true,
      restart_delay: 2000,
    },
    node('api', 'dist/main.js'),
    node('gateway', 'dist/gateway/main.js'),
    node('processor', 'dist/processor/main.js'),
    node('notifier', 'dist/notifier/main.js'),
    node('summarizer', 'dist/summarizer/main.js'),
    {
      name: 'web',
      cwd: web,
      script: path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
      args: ['preview', '--port', '4173', '--strictPort'],
      windowsHide: true,
      restart_delay: 3000,
    },
    {
      name: 'tunnel',
      script: cloudflared,
      args: ['tunnel', '--config', tunnelConfig, 'run', 'veetrax'],
      interpreter: 'none',
      windowsHide: true,
      restart_delay: 5000,
    },
  ],
};
