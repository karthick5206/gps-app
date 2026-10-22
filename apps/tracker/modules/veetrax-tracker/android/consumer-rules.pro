# Applied to the app's release build (R8). Without these the app crashed on launch:
# "NoSuchMethodException: androidx.work.impl.WorkDatabase_Impl.<init> []" from WorkManagerInitializer.

# Room creates generated databases (WorkDatabase_Impl) through their no-arg constructor by reflection.
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
# WorkManager instantiates workers and initializers by class name.
-keep class * extends androidx.work.ListenableWorker { <init>(android.content.Context, androidx.work.WorkerParameters); }
-keep class * implements androidx.startup.Initializer { <init>(); }

# Tracking engine: service, receivers and worker are referenced from the manifest / by name.
-keep class com.sasvata.veetrax.trackerengine.** { *; }
