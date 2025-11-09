module.exports = {
  apps: [
    {
      name: "odds-diff-bot",
      script: "index.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "another-service",
      script: "src/another.js",
      watch: false,
    },
  ],
};
