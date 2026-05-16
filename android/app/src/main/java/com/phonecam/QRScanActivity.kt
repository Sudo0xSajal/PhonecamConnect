package com.phonecam

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.HapticFeedbackConstants
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.mlkit.vision.MlKitAnalyzer
import androidx.camera.view.CameraController
import androidx.camera.view.LifecycleCameraController
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.phonecam.databinding.ActivityQrScanBinding

class QRScanActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "QRScan"
        private const val CAMERA_PERMISSION_REQUEST = 100
    }

    private lateinit var binding: ActivityQrScanBinding
    private var cameraController: LifecycleCameraController? = null
    private var scanned = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityQrScanBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnBack.setOnClickListener { finish() }

        if (hasCameraPermission()) {
            startScanner()
        } else {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.CAMERA),
                CAMERA_PERMISSION_REQUEST
            )
        }
    }

    private fun hasCameraPermission() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

    private fun startScanner() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                val cameraProvider = cameraProviderFuture.get()
                cameraProvider.unbindAll()

                val barcodeScanner = BarcodeScanning.getClient()
                val controller = LifecycleCameraController(this)

                controller.setImageAnalysisAnalyzer(
                    ContextCompat.getMainExecutor(this),
                    MlKitAnalyzer(
                        listOf(barcodeScanner),
                        CameraController.COORDINATE_SYSTEM_VIEW_REFERENCED,
                        ContextCompat.getMainExecutor(this)
                    ) { result ->
                        if (scanned) return@MlKitAnalyzer

                        val barcodes = result.getValue(barcodeScanner) ?: return@MlKitAnalyzer
                        for (barcode in barcodes) {
                            if (barcode.format != Barcode.FORMAT_QR_CODE) continue
                            val raw = barcode.rawValue ?: continue
                            val wsUrl = convertToWsUrl(raw)
                            if (wsUrl != null) {
                                scanned = true
                                Log.d(TAG, "QR: $raw  →  $wsUrl")
                                onQRFound(wsUrl)
                                break
                            }
                        }
                    }
                )

                controller.bindToLifecycle(this)
                binding.previewView.controller = controller
                cameraController = controller
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start camera: ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun convertToWsUrl(raw: String): String? {
        return when {
            raw.startsWith("ws://") || raw.startsWith("wss://") -> raw
            raw.startsWith("http://") -> {
                var url = raw.replace("http://", "ws://")
                if (url.contains(":7780")) url = url.replace(":7780", ":7779")
                url
            }
            raw.startsWith("https://") -> raw.replace("https://", "wss://")
            raw.matches(Regex("\\d{1,3}(\\.\\d{1,3}){3}:\\d+")) -> "ws://$raw"
            else -> null
        }
    }

    private fun onQRFound(wsUrl: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            binding.root.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        } else {
            binding.root.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        }

        binding.scanOverlay.setSuccessState(wsUrl)

        binding.root.postDelayed({
            setResult(RESULT_OK, Intent().putExtra("ws_url", wsUrl))
            finish()
        }, 700)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERMISSION_REQUEST &&
            grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startScanner()
        } else {
            finish()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraController?.unbind()
        cameraController = null
    }
}
