/**
 * Adds Firebase (needed for push on Android) when google-services.json is present, so builds without it still work.
 * Get the file from the Firebase console (Android app com.sasvata.veetracer) and place it next to app.json,
 * or point GOOGLE_SERVICES_JSON at it (e.g. an EAS file secret). It is git-ignored.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const file = process.env.GOOGLE_SERVICES_JSON || './google-services.json';
  if (fs.existsSync(path.resolve(__dirname, file))) config.android = { ...config.android, googleServicesFile: file };
  return config;
};
