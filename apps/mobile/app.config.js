/**
 * Adds Firebase (needed for push on Android) when google-services.json is present, so builds without it still work.
 * Get the file from the Firebase console (Android app com.sasvata.veetrax) and place it next to app.json,
 * or point GOOGLE_SERVICES_JSON at it (e.g. an EAS file secret). It is git-ignored.
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * The CAMERA permission (bill photos) makes Google Play assume the camera and autofocus are required,
 * which hides the app from phones/tablets without them. Mark them optional.
 */
const OPTIONAL_FEATURES = ['android.hardware.camera', 'android.hardware.camera.autofocus', 'android.hardware.camera.any'];
const withOptionalCamera = (config) =>
  withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);
    for (const name of OPTIONAL_FEATURES) {
      const existing = features.find((f) => f.$['android:name'] === name);
      if (existing) existing.$['android:required'] = 'false';
      else features.push({ $: { 'android:name': name, 'android:required': 'false' } });
    }
    return c;
  });

module.exports = ({ config }) => {
  const file = process.env.GOOGLE_SERVICES_JSON || './google-services.json';
  if (fs.existsSync(path.resolve(__dirname, file))) config.android = { ...config.android, googleServicesFile: file };
  return withOptionalCamera(config);
};
