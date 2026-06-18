/**
 * PM2 ecosystem config for NSI LiveMeet API.
 * Default deploy path: /var/www/nsi-livemeet-server (change cwd if yours differs).
 */
module.exports = {
  apps: [
    {
      name: "nsi-livemeet-api",
      script: "dist/index.js",
      cwd: "/var/www/nsi-livemeet-server",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
      },
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
