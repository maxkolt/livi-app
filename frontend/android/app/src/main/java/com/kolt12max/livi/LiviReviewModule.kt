package com.kolt12max.livi

import android.content.Intent
import android.net.Uri
import com.facebook.react.common.LifecycleState
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.google.android.play.core.review.ReviewInfo
import com.google.android.play.core.review.ReviewManager
import com.google.android.play.core.review.ReviewManagerFactory
import java.util.UUID

/** Google owns the rating form. Never style, dismiss, or infer submission from its result. */
class LiviReviewModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var generation = 0
  private var prepared: Triple<String, ReviewManager, ReviewInfo>? = null
  private var preparingPromise: Promise? = null
  private var flowInFlight = false
  private var invalidated = false

  override fun getName() = "LiviReviewModule"

  private fun clearPreparation() {
    generation++
    prepared = null
    preparingPromise?.resolve(null)
    preparingPromise = null
  }

  private fun foregroundActivity(): MainActivity? {
    if (invalidated || reactApplicationContext.lifecycleState != LifecycleState.RESUMED) return null
    val activity = reactApplicationContext.currentActivity as? MainActivity ?: return null
    if (activity.isFinishing || activity.isDestroyed || activity.isInPictureInPictureMode ||
      !activity.hasWindowFocus() || LiviAppModule.isActiveCallForegroundRunning()) return null
    return activity
  }

  @ReactMethod
  fun prepareReview(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      clearPreparation()
      val requestGeneration = generation
      if (flowInFlight || foregroundActivity() == null) {
        promise.resolve(null)
        return@runOnUiThread
      }
      preparingPromise = promise
      try {
        val manager = ReviewManagerFactory.create(reactApplicationContext)
        manager.requestReviewFlow().addOnCompleteListener { task ->
          if (generation != requestGeneration) return@addOnCompleteListener
          preparingPromise = null
          if (!task.isSuccessful || foregroundActivity() == null) {
            promise.resolve(null)
          } else {
            val token = UUID.randomUUID().toString()
            prepared = Triple(token, manager, task.result)
            promise.resolve(token)
          }
        }
      } catch (_: Exception) {
        preparingPromise = null
        promise.resolve(null)
      }
    }
  }

  @ReactMethod
  fun cancelReviewPreparation() {
    UiThreadUtil.runOnUiThread {
      clearPreparation()
      // Deliberately do not close an already launched Google form.
    }
  }

  @ReactMethod
  fun launchPreparedReview(token: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      val review = prepared
      prepared = null
      val activity = foregroundActivity()
      if (review == null || review.first != token || activity == null || flowInFlight) {
        promise.resolve(false)
        return@runOnUiThread
      }
      try {
        flowInFlight = true
        review.second.launchReviewFlow(activity, review.third).addOnCompleteListener {
          flowInFlight = false
        }
        // True only means the launch request was made, never that a review was sent or shown.
        promise.resolve(true)
      } catch (_: Exception) {
        flowInFlight = false
        promise.resolve(false)
      }
    }
  }

  @ReactMethod
  fun openStoreListing(promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val intent = Intent(Intent.ACTION_VIEW,
          Uri.parse("https://play.google.com/store/apps/details?id=com.kolt12max.livi"))
          .setPackage("com.android.vending")
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        reactApplicationContext.startActivity(intent)
        promise.resolve(true)
      } catch (_: Exception) { promise.resolve(false) }
    }
  }

  override fun invalidate() {
    UiThreadUtil.runOnUiThread {
      invalidated = true
      clearPreparation()
    }
    super.invalidate()
  }
}
