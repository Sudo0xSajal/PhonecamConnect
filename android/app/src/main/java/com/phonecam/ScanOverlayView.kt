package com.phonecam

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.graphics.toColorInt

/**
 * Draws a QR scan aiming box with corner brackets.
 * Call setSuccessState(url) when a QR code is found — turns green.
 */
class ScanOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private val dimPaint = Paint().apply {
        color = "#99000000".toColorInt()
    }

    private val cornerPaint = Paint().apply {
        color = "#1B6FEB".toColorInt()
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
        isAntiAlias = true
    }

    private val successPaint = Paint().apply {
        color = "#16C784".toColorInt()
        style = Paint.Style.STROKE
        strokeWidth = 4f
        strokeCap = Paint.Cap.ROUND
        isAntiAlias = true
    }

    private var isSuccess = false
    private var boxRect = RectF()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val boxSize = minOf(w.toFloat(), h.toFloat()) * 0.65f
        val cx = w / 2f
        val cy = h / 2f
        boxRect = RectF(
            cx - boxSize / 2f,
            cy - boxSize / 2f,
            cx + boxSize / 2f,
            cy + boxSize / 2f
        )
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()

        // Draw dim overlay with transparent box cutout
        canvas.drawRect(0f, 0f, w, boxRect.top, dimPaint)
        canvas.drawRect(0f, boxRect.top, boxRect.left, boxRect.bottom, dimPaint)
        canvas.drawRect(boxRect.right, boxRect.top, w, boxRect.bottom, dimPaint)
        canvas.drawRect(0f, boxRect.bottom, w, h, dimPaint)

        // Draw corner brackets
        val paint = if (isSuccess) successPaint else cornerPaint
        val cornerLen = boxRect.width() * 0.12f
        val r = 8f

        drawCornerBracket(canvas, paint, boxRect.left, boxRect.top, cornerLen, r, 1f, 1f)
        drawCornerBracket(canvas, paint, boxRect.right, boxRect.top, cornerLen, r, -1f, 1f)
        drawCornerBracket(canvas, paint, boxRect.left, boxRect.bottom, cornerLen, r, 1f, -1f)
        drawCornerBracket(canvas, paint, boxRect.right, boxRect.bottom, cornerLen, r, -1f, -1f)
    }

    private fun drawCornerBracket(
        canvas: Canvas, paint: Paint,
        x: Float, y: Float, len: Float, radius: Float,
        dx: Float, dy: Float
    ) {
        val path = Path()
        path.moveTo(x + dx * len, y)
        path.lineTo(x + dx * radius, y)
        path.quadTo(x, y, x, y + dy * radius)
        path.lineTo(x, y + dy * len)
        canvas.drawPath(path, paint)
    }

    fun setSuccessState(url: String) {
        isSuccess = true
        invalidate()
    }
}