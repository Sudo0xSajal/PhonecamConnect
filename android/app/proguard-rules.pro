# PhoneCam ProGuard Rules

# Keep WebSocket client
-keep class org.java_websocket.** { *; }
-dontwarn org.java_websocket.**

# Keep OkHttp
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**
-keep interface okhttp3.** { *; }

# Keep MLKit barcode
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**

# Keep Gson
-keepattributes Signature
-keepattributes *Annotation*
-keep class com.google.gson.** { *; }

# Keep app model classes
-keep class com.phonecam.** { *; }

# Keep CameraX
-keep class androidx.camera.** { *; }
-dontwarn androidx.camera.**