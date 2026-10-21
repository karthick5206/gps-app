/**
 * Expo config plugin for the native VeeTrax tracking engine (Android only).
 * Adds to the APP AndroidManifest:
 *  - permissions: location (fine, coarse, background), foreground service (+ location type), notifications,
 *    boot completed, wake lock, battery-optimisation request, internet;
 *  - <service> TrackerService (exported=false, foregroundServiceType=location);
 *  - <receiver> BootReceiver for BOOT_COMPLETED, MY_PACKAGE_REPLACED and fast-boot variants.
 * Gradle dependencies are in the module's own android/build.gradle (autolinked), so nothing to add here.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const PKG = 'com.sasvata.veetrax.trackerengine';

const PERMISSIONS = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.INTERNET',
];

function upsert(list, name, item) {
  const i = list.findIndex((x) => x.$ && x.$['android:name'] === name);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

const withVeetraxTracker = (config) => {
  config = AndroidConfig.Permissions.withPermissions(config, PERMISSIONS);
  return withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);

    app.service = app.service || [];
    upsert(app.service, `${PKG}.TrackerService`, {
      $: {
        'android:name': `${PKG}.TrackerService`,
        'android:exported': 'false',
        'android:foregroundServiceType': 'location',
        // Keep the process alive with the service; don't stop it when the task is removed.
        'android:stopWithTask': 'false',
      },
    });

    app.receiver = app.receiver || [];
    upsert(app.receiver, `${PKG}.BootReceiver`, {
      // exported=true so the system can deliver BOOT_COMPLETED on every OEM build; the receiver only reacts to
      // the actions below and to our own explicit restart intent, and at most starts our own service.
      $: { 'android:name': `${PKG}.BootReceiver`, 'android:exported': 'true', 'android:enabled': 'true' },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
            { $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' } },
            { $: { 'android:name': 'com.htc.intent.action.QUICKBOOT_POWERON' } },
          ],
        },
        { action: [{ $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } }] },
      ],
    });
    return cfg;
  });
};

module.exports = withVeetraxTracker;
