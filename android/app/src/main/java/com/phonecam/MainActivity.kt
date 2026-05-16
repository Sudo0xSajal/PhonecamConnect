package com.phonecam

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import android.util.Size
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.phonecam.databinding.ActivityMainBinding
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "PhoneCam"
        private const val JPEG_QUALITY = 80
        private const val TARGET_FPS = 30
        private const val FRAME_INTERVAL_MS = 1000L / TARGET_FPS
        private const val PING_INTERVAL_SEC = 5L
        private const val RECONNECT_DELAY_MS = 3000L
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var scheduledExecutor: ScheduledExecutorService

    // WebSocket
    private var wsClient: PhoneCamWSClient? = null
    private var wsUrl: String? = null
    private var pingFuture: ScheduledFuture<*>? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var userDisconnected = false

    // Camera
    private var camera: Camera? = null
    private var imageAnalysis: ImageAnalysis? = null
    private var currentResolution = "1920x1080"
    private var currentFps = 30
    private var isTorchOn = false
    private var isFrontCamera = false

    // State — TRUE by default so frames are sent immediately after handshake
    @Volatile private var isStreaming = true
    private var lastFrameTime = 0L

    // WakeLock
    private var wakeLock: PowerManager.WakeLock? = null

    // Foreground service
    private var streamingService: StreamingService? = null
    private var serviceBound = false
    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            streamingService = (binder as StreamingService.StreamBinder).getService()
            serviceBound = true
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            streamingService = null
            serviceBound = false
        }
    }

    // Network callback
    private val connectivityManager by lazy {
        getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            val url = wsUrl ?: return
            if (!userDisconnected && wsClient?.isOpen != true) {
                Log.d(TAG, "Network available — scheduling reconnect")
                scheduleReconnect(url)
            }
        }
        override fun onLost(network: Network) {
            Log.d(TAG, "Network lost")
            isStreaming = false
            runOnUiThread { updateStatus(getString(R.string.status_offline)) }
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        if (permissions[Manifest.permission.CAMERA] == true) {
            startCamera()
        } else {
            showError("Camera permission is required to stream")
        }
    }

    private val qrScanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == RESULT_OK) {
            val url = result.data?.getStringExtra("ws_url") ?: return@registerForActivityResult
            if (url.isNotEmpty()) {
                userDisconnected = false
                connectToDesktop(url)
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        cameraExecutor = Executors.newSingleThreadExecutor()
        scheduledExecutor = Executors.newScheduledThreadPool(2)

        acquireWakeLock()
        setupUI()
        requestAllPermissions()
        registerNetworkCallback()
    }

    override fun onDestroy() {
        super.onDestroy()
        userDisconnected = true
        isStreaming = false
        stopPingTimer()
        cancelReconnect()
        cameraExecutor.execute {
            try { wsClient?.closeBlocking() } catch (_: Exception) {}
        }
        wsClient = null
        cameraExecutor.shutdown()
        scheduledExecutor.shutdown()
        releaseWakeLock()
        unregisterNetworkCallback()
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
    }

    // ── WakeLock ──────────────────────────────────────────────────────────────

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        @Suppress("DEPRECATION")
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "PhoneCam:StreamingWakeLock"
        ).also { it.acquire(2 * 60 * 60 * 1000L) }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    // ── Network ───────────────────────────────────────────────────────────────

    private fun registerNetworkCallback() {
        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        try { connectivityManager.registerNetworkCallback(req, networkCallback) }
        catch (e: Exception) { Log.w(TAG, "Network callback not registered: ${e.message}") }
    }

    private fun unregisterNetworkCallback() {
        try { connectivityManager.unregisterNetworkCallback(networkCallback) }
        catch (_: Exception) {}
    }

    // ── UI Setup ──────────────────────────────────────────────────────────────

    private fun setupUI() {
        binding.btnScanQr.setOnClickListener {
            qrScanLauncher.launch(Intent(this, QRScanActivity::class.java))
        }

        binding.btnManualConnect.setOnClickListener {
            val raw = binding.etManualUrl.text.toString().trim()
            if (raw.isEmpty()) {
                showError("Enter a URL — e.g. ws://192.168.1.42:7779")
                return@setOnClickListener
            }
            val url = normalizeWsUrl(raw)
            if (url == null) {
                showError("URL must start with ws://, wss://, or http://")
                return@setOnClickListener
            }
            userDisconnected = false
            connectToDesktop(url)
        }

        binding.btnDisconnect.setOnClickListener {
            userDisconnected = true
            isStreaming = false
            cancelReconnect()
            closeWsOnBackground()
            stopStreamingService()
            runOnUiThread {
                showDisconnectedUI()
                updateStatus(getString(R.string.status_offline))
            }
        }

        binding.btnFlipCamera.setOnClickListener {
            isFrontCamera = !isFrontCamera
            restartCamera()
        }

        binding.btnTorch.setOnClickListener {
            isTorchOn = !isTorchOn
            camera?.cameraControl?.enableTorch(isTorchOn)
            binding.btnTorch.alpha = if (isTorchOn) 1f else 0.5f
        }

        var spinnerReady = false
        binding.spinnerResolution.setOnItemSelectedListener { _, _, _, _ ->
            if (!spinnerReady) { spinnerReady = true; return@setOnItemSelectedListener }
            val options = listOf("1920x1080", "1280x720", "3840x2160", "640x480")
            currentResolution = options.getOrElse(
                binding.spinnerResolution.selectedItemPosition) { "1920x1080" }
            sendSettingsToDesktop()
            restartCamera()
        }

        showDisconnectedUI()
    }

    // ── Permissions ───────────────────────────────────────────────────────────

    private fun requestAllPermissions() {
        val needed = mutableListOf<String>()
        if (!hasPerm(Manifest.permission.CAMERA))        needed.add(Manifest.permission.CAMERA)
        if (!hasPerm(Manifest.permission.RECORD_AUDIO)) needed.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPerm(Manifest.permission.POST_NOTIFICATIONS))
            needed.add(Manifest.permission.POST_NOTIFICATIONS)

        if (needed.isEmpty()) startCamera() else permissionLauncher.launch(needed.toTypedArray())
    }

    private fun hasPerm(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    // ── Camera ────────────────────────────────────────────────────────────────

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener(
            { bindCameraUseCases(future.get()) },
            ContextCompat.getMainExecutor(this)
        )
    }

    private fun restartCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            provider.unbindAll()
            bindCameraUseCases(provider)
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindCameraUseCases(cameraProvider: ProcessCameraProvider) {
        val (w, h) = parseResolution(currentResolution)
        val resolutionSelector = ResolutionSelector.Builder()
            .setResolutionStrategy(
                ResolutionStrategy(
                    Size(w, h),
                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER
                )
            ).build()

        val preview = Preview.Builder()
            .setResolutionSelector(resolutionSelector)
            .build()
            .also { it.setSurfaceProvider(binding.cameraPreview.surfaceProvider) }

        imageAnalysis = ImageAnalysis.Builder()
            .setResolutionSelector(resolutionSelector)
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .also { ia ->
                ia.setAnalyzer(cameraExecutor) { imageProxy -> processFrame(imageProxy) }
            }

        val selector = if (isFrontCamera)
            CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

        try {
            cameraProvider.unbindAll()
            camera = cameraProvider.bindToLifecycle(this, selector, preview, imageAnalysis)
        } catch (e: Exception) {
            Log.e(TAG, "Camera bind failed: ${e.message}")
            showError("Camera error: ${e.message}")
        }
    }

    private fun parseResolution(res: String): Pair<Int, Int> {
        return try {
            val parts = res.split("x")
            parts[0].toInt() to parts[1].toInt()
        } catch (_: Exception) { 1920 to 1080 }
    }

    private fun processFrame(imageProxy: ImageProxy) {
        val now = System.currentTimeMillis()
        if (now - lastFrameTime < FRAME_INTERVAL_MS) {
            imageProxy.close()
            return
        }

        // Only send if WebSocket is open — don't require isStreaming flag
        if (wsClient?.isOpen != true) {
            imageProxy.close()
            return
        }

        lastFrameTime = now

        try {
            val jpegBytes = yuvToJpeg(imageProxy)
            // FIX: Must use ByteBuffer.wrap() — send(ByteArray) is NOT supported
            // by Java-WebSocket and silently does nothing
            wsClient?.send(ByteBuffer.wrap(jpegBytes))
            Log.v(TAG, "Frame sent: ${jpegBytes.size} bytes")
        } catch (e: Exception) {
            Log.e(TAG, "Frame error: ${e.message}")
        } finally {
            imageProxy.close()
        }
    }

    private fun yuvToJpeg(image: ImageProxy): ByteArray {
        val planes = image.planes
        val yBuffer = planes[0].buffer
        val uBuffer = planes[1].buffer
        val vBuffer = planes[2].buffer

        val ySize = yBuffer.remaining()
        val uSize = uBuffer.remaining()
        val vSize = vBuffer.remaining()

        val nv21 = ByteArray(ySize + uSize + vSize)
        yBuffer.get(nv21, 0, ySize)
        vBuffer.get(nv21, ySize, vSize)
        uBuffer.get(nv21, ySize + vSize, uSize)

        val out = ByteArrayOutputStream()
        val yuv = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
        yuv.compressToJpeg(Rect(0, 0, image.width, image.height), JPEG_QUALITY, out)
        return out.toByteArray()
    }

    // ── WebSocket Logic ───────────────────────────────────────────────────────

    private fun connectToDesktop(url: String) {
        cancelReconnect()
        closeWsOnBackground()

        wsUrl = url
        val uri = try { URI(url) } catch (e: Exception) { showError("Invalid URL"); return }

        updateStatus("Connecting…")
        Log.d(TAG, "Connecting to $url …")

        wsClient = PhoneCamWSClient(
            uri = uri,
            onOpenAction = {
                runOnUiThread {
                    Log.d(TAG, "✓ WebSocket connected")
                    updateStatus("Connected — streaming")
                    showConnectedUI()
                    startPingTimer()
                    sendHandshake()
                    isStreaming = true   // Start streaming immediately on connect
                    startStreamingService()
                }
            },
            onMessageAction = { msg ->
                runOnUiThread { handleMessage(msg) }
            },
            onCloseAction = { code, reason ->
                runOnUiThread {
                    Log.d(TAG, "WebSocket closed: code=$code reason=$reason")
                    isStreaming = false
                    updateStatus(getString(R.string.status_offline))
                    showDisconnectedUI()
                    stopPingTimer()
                    stopStreamingService()
                    if (!userDisconnected) scheduleReconnect(url)
                }
            },
            onErrorAction = { ex ->
                runOnUiThread {
                    Log.e(TAG, "WebSocket error: ${ex?.message}")
                    showError("Connection error: ${ex?.message}")
                }
            }
        )
        wsClient?.connect()
    }

    private fun handleMessage(raw: String) {
        try {
            val json = JSONObject(raw)
            when (json.optString("type")) {
                "handshake_ack" -> {
                    Log.d(TAG, "✅ Handshake acknowledged — streaming active")
                    isStreaming = true
                    val sessionId = json.optString("sessionId", "")
                    Toast.makeText(this, "Streaming to desktop ✓", Toast.LENGTH_SHORT).show()
                    streamingService?.updateNotification("Desktop", currentResolution, currentFps)
                }
                "pong" -> {
                    Log.v(TAG, "pong received")
                }
                "command" -> {
                    when (json.optString("command")) {
                        "torch" -> {
                            isTorchOn = json.optJSONObject("payload")?.optBoolean("value") ?: false
                            camera?.cameraControl?.enableTorch(isTorchOn)
                        }
                        "flip_camera" -> {
                            runOnUiThread {
                                isFrontCamera = !isFrontCamera
                                restartCamera()
                                Log.d(TAG, "Camera flipped: isFront=$isFrontCamera")
                            }
                        }
                        "mirror" -> {
                            // Mirror is handled on desktop via CSS scaleX
                            // No action needed on Android side
                        }
                        "resolution" -> {
                            val res = json.optJSONObject("payload")?.optString("value") ?: return
                            if (res != currentResolution) {
                                currentResolution = res
                                restartCamera()
                            }
                        }
                        "fps" -> {
                            currentFps = json.optJSONObject("payload")?.optInt("value") ?: 30
                        }
                    }
                }
                "disconnect" -> {
                    userDisconnected = true
                    isStreaming = false
                    closeWsOnBackground()
                    showDisconnectedUI()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "JSON Error: ${e.message}")
        }
    }

    private fun sendHandshake() {
        // Field names must match what desktop main.js expects exactly
        val msg = JSONObject().apply {
            put("type",         "handshake")
            put("deviceName",   Build.MODEL)          // desktop reads: msg.deviceName
            put("batteryLevel", getBatteryLevel())     // desktop reads: msg.batteryLevel
            put("resolution",   currentResolution)     // desktop reads: msg.resolution
            put("fps",          currentFps)            // desktop reads: msg.fps
            put("appVersion",   "1.0.0")
        }
        Log.d(TAG, "Sending handshake: $msg")
        wsClient?.send(msg.toString())
    }

    private fun sendSettingsToDesktop() {
        if (wsClient?.isOpen != true) return
        val msg = JSONObject().apply {
            put("type",       "settings_change")      // desktop reads: msg.type === 'settings_change'
            put("resolution", currentResolution)
            put("fps",        currentFps)
        }
        wsClient?.send(msg.toString())
    }

    private fun getBatteryLevel(): Int {
        val bm = getSystemService(BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    // ── Reconnect & Ping ──────────────────────────────────────────────────────

    private fun scheduleReconnect(url: String) {
        cancelReconnect()
        if (userDisconnected) return
        Log.d(TAG, "Scheduling reconnect in ${RECONNECT_DELAY_MS}ms")
        reconnectFuture = scheduledExecutor.schedule({
            runOnUiThread { connectToDesktop(url) }
        }, RECONNECT_DELAY_MS, TimeUnit.MILLISECONDS)
    }

    private fun cancelReconnect() {
        reconnectFuture?.cancel(false)
        reconnectFuture = null
    }

    private fun startPingTimer() {
        stopPingTimer()
        pingFuture = scheduledExecutor.scheduleAtFixedRate({
            try {
                if (wsClient?.isOpen == true) {
                    wsClient?.send(JSONObject().apply { put("type", "ping") }.toString())
                }
            } catch (_: Exception) {}
        }, PING_INTERVAL_SEC, PING_INTERVAL_SEC, TimeUnit.SECONDS)
    }

    private fun stopPingTimer() {
        pingFuture?.cancel(false)
        pingFuture = null
    }

    private fun closeWsOnBackground() {
        val client = wsClient ?: return
        wsClient = null
        isStreaming = false
        cameraExecutor.execute {
            try { client.closeBlocking() } catch (_: Exception) {}
        }
    }

    // ── Foreground Service ────────────────────────────────────────────────────

    private fun startStreamingService() {
        val intent = Intent(this, StreamingService::class.java)
        ContextCompat.startForegroundService(this, intent)
        bindService(intent, serviceConnection, BIND_AUTO_CREATE)
    }

    private fun stopStreamingService() {
        if (serviceBound) {
            unbindService(serviceConnection)
            serviceBound = false
        }
        stopService(Intent(this, StreamingService::class.java))
    }

    // ── UI Helpers ────────────────────────────────────────────────────────────

    private fun updateStatus(text: String) {
        binding.tvStatus.text = text
        binding.statusBadge.text = text
    }

    private fun showConnectedUI() {
        binding.layoutConnect.visibility = View.GONE
        binding.layoutStreaming.visibility = View.VISIBLE
        binding.btnDisconnect.visibility = View.VISIBLE
    }

    private fun showDisconnectedUI() {
        binding.layoutConnect.visibility = View.VISIBLE
        binding.layoutStreaming.visibility = View.GONE
        binding.btnDisconnect.visibility = View.GONE
    }

    private fun normalizeWsUrl(raw: String): String? {
        return when {
            raw.startsWith("ws://") || raw.startsWith("wss://") -> raw
            raw.startsWith("http://") -> raw.replace("http://", "ws://")
            raw.startsWith("https://") -> raw.replace("https://", "wss://")
            raw.matches(Regex("\\d+\\.\\d+\\.\\d+\\.\\d+.*")) -> "ws://$raw"
            else -> null
        }
    }

    private fun showError(msg: String) {
        runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    }
}

// ── WebSocket Client ──────────────────────────────────────────────────────────

class PhoneCamWSClient(
    uri: URI,
    private val onOpenAction: () -> Unit,
    private val onMessageAction: (String) -> Unit,
    private val onCloseAction: (Int, String?) -> Unit,
    private val onErrorAction: (Exception?) -> Unit
) : WebSocketClient(uri) {

    init {
        setConnectionLostTimeout(30)
    }

    override fun onOpen(handshake: ServerHandshake?) {
        onOpenAction()
    }

    override fun onMessage(message: String?) {
        message?.let { onMessageAction(it) }
    }

    override fun onClose(code: Int, reason: String?, remote: Boolean) {
        onCloseAction(code, reason)
    }

    override fun onError(ex: Exception?) {
        onErrorAction(ex)
    }
}

// ── Spinner extension ─────────────────────────────────────────────────────────

fun android.widget.Spinner.setOnItemSelectedListener(
    listener: (parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) -> Unit
) {
    onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
        override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) =
            listener(p, v, pos, id)
        override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
    }
}