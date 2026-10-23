/**
 * Expo config plugin: sign Android release builds with the VeeTrax release key instead of the template's public
 * debug key (anyone has that one, so it can't protect updates and the Play Store rejects it).
 *
 * The keystore and its password are NOT in the repo. Each build machine sets them in its Gradle user properties
 * (%USERPROFILE%\.gradle\gradle.properties):
 *   VEETRAX_SIGNING_STORE_FILE=C:/VeeTrax-Backup-Key/signing/veetrax-release.jks
 *   VEETRAX_SIGNING_PASSWORD=...           (store and key password)
 * Without them a release build fails with a clear message instead of silently using the debug key.
 *
 * Usage in app.json plugins: ["../../tooling/expo/with-release-signing.js", { "keyAlias": "veetrax" }]
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// veetrax-release-signing';

function addReleaseSigning(gradle, keyAlias) {
  if (gradle.includes(MARKER)) return gradle;
  const signingConfigs = 'signingConfigs {\n';
  if (!gradle.includes(signingConfigs)) throw new Error('with-release-signing: signingConfigs block not found in app/build.gradle');
  const releaseConfig = `signingConfigs {
        ${MARKER}
        release {
            def storePath = findProperty('VEETRAX_SIGNING_STORE_FILE')
            if (storePath) {
                storeFile file(storePath)
                storePassword findProperty('VEETRAX_SIGNING_PASSWORD')
                keyAlias '${keyAlias}'
                keyPassword findProperty('VEETRAX_SIGNING_PASSWORD')
            }
        }
`;
  let out = gradle.replace(signingConfigs, releaseConfig);
  // Only the release *build type* switches keys (search inside buildTypes, after its `release {`).
  const buildTypes = out.indexOf('buildTypes {');
  const releaseType = buildTypes < 0 ? -1 : out.indexOf('release {', buildTypes);
  const debugLine = releaseType < 0 ? -1 : out.indexOf('signingConfig signingConfigs.debug', releaseType);
  if (debugLine < 0) throw new Error('with-release-signing: release buildType signingConfig not found in app/build.gradle');
  out = out.slice(0, debugLine) + 'signingConfig signingConfigs.release' + out.slice(debugLine + 'signingConfig signingConfigs.debug'.length);
  // Fail release builds without the key rather than shipping a debug-signed APK.
  out += `
${MARKER}: refuse to build a release without the VeeTrax release key
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase().contains('release') } && !findProperty('VEETRAX_SIGNING_STORE_FILE')) {
        throw new GradleException('VeeTrax release signing is not configured: set VEETRAX_SIGNING_STORE_FILE and VEETRAX_SIGNING_PASSWORD in ~/.gradle/gradle.properties (see tooling/expo/with-release-signing.js).')
    }
}
`;
  return out;
}

module.exports = function withReleaseSigning(config, { keyAlias } = {}) {
  if (!keyAlias) throw new Error('with-release-signing: keyAlias is required');
  return withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy') throw new Error('with-release-signing: only Groovy build.gradle is supported');
    c.modResults.contents = addReleaseSigning(c.modResults.contents, keyAlias);
    return c;
  });
};

module.exports.addReleaseSigning = addReleaseSigning;
