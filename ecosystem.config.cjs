module.exports = {
  apps: [{
    name: 'march7th-web',
    cwd: __dirname,
    script: './server.mjs',
    interpreter: process.execPath,
    watch: false,
    instances: 1,
    exec_mode: 'fork',
    kill_timeout: 120000,
    max_memory_restart: '192M',
    env: { NODE_ENV: 'production', HOST: process.env.HOST || '127.0.0.1', PORT: process.env.PORT || '18077' },
  }],
}
