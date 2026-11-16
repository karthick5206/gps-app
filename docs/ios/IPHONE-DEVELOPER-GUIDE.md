# iPhone (iOS) — new changes in v1.18 for the VeeTrax and VeeTrax Tracker apps

For the Mac developer who already builds both apps for iOS. Only the **new changes since v1.17.1** are listed. Pull
`main` after the v1.18.0 release (branch `release/1.18` until then), run `npm ci` at the root, then for each app:
`npx expo prebuild -p ios --clean` and build in Xcode as before.

## What's new

| Feature | VeeTrax Tracker (`apps/tracker`) | VeeTrax (`apps/mobile`) |
|---|---|---|
| **Person photo** (profile picture on the map, status-coloured ring, hover card on web) | Profile → take photo (front camera) / choose photo / remove — `src/components/ProfilePhoto.tsx`, `src/app/profile.tsx` | Photos shown on the map, lists and vehicle detail — `src/features/objects/object-photo.tsx`, `src/features/map/FleetMap.tsx` |
| **Location photo notes** (1–5 photos, category Bill / Receipt / Visit / Other, note, amount; saved with GPS position, time, address; offline queue) | Home card + menu → "Add photo here" — `src/app/photo-note.tsx`, `src/lib/photo-notes.ts`, `src/lib/photo-note-queue.ts` | More → Photo notes — `src/app/photo-notes.tsx`, `src/features/photo-notes/*` |
| **Feature switches** (coming in the same release) | Photo features hidden until the company (or the account owner in the Tracker app) switches them on | Same; admins can switch them on in Settings |

## iOS checklist (both apps)

1. **New dependency (Tracker):** `expo-file-system ~58.0.9` (already part of Expo; run `npx expo prebuild -p ios --clean`
   so CocoaPods picks it up).
2. **Permission texts changed — new native build needed** (`app.json` → `ios.infoPlist` and plugin options):
   - Tracker: camera ("Take your check-in selfie or video if your employer asks for one, your profile photo, or a photo
     of a bill or place to save with its location."), photo library ("Choose a photo for your profile or a photo note."),
     location when in use (updated text). The photo-library permission is now **enabled** (it was off before).
   - VeeTrax: camera, photo library and `NSLocationWhenInUseUsageDescription` (new).
3. **HEIC → JPEG:** the pickers use quality 0.8 and the "compatible" asset mode, so iPhone camera shots and HEIC library
   photos upload as JPEG; anything still HEIC is refused with a message. Please verify on a real iPhone with: a camera
   shot, a HEIC photo from the library, a Live Photo, and a large photo (must stay under 10 MB).
4. **Offline queue:** take a photo note in airplane mode, kill and reopen the app, go online → it uploads **once**.
5. **Sign-out:** unsent notes and cached photos are removed on sign-out (privacy) — confirm on iOS.

## Test on a real iPhone (both apps)

- [ ] Permission prompts show the new texts; denying a permission shows a message, no crash.
- [ ] Tracker: set / replace / remove profile photo → it appears on the web live map within a minute.
- [ ] Photo note with 1 and with 5 photos, each category, with and without amount → visible on the web
      "Photos & notes" page with the right place and time.
- [ ] VeeTrax: person photos on the map markers, list and vehicle detail.
- [ ] With the photo features switched off for the company, the photo screens are hidden.

Server endpoints (for debugging): Tracker — `/api/tracker/v1/photo`, `/api/tracker/v1/photo-notes`;
VeeTrax — `/api/objects/:id/photo`, `/api/photo-notes`.
