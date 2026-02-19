module.exports = {
  apps: [{
    name: 'battle-city',
    script: 'server.js',
    env: {
      PORT: 3000,
      ADMIN_TOKEN: 'changeme'   // ← change this
    }
  }]
};
