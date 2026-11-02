package com.next.workhub

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "Workhub"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    handleRoute(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleRoute(intent)
  }

  /** Notification taps carry a JSON {tag, route}; JS validates it again before navigating. */
  private fun handleRoute(intent: Intent?) {
    val json = intent?.getStringExtra(WorkhubNotifications.EXTRA_ROUTE) ?: return
    intent.removeExtra(WorkhubNotifications.EXTRA_ROUTE)
    WorkhubNativeModule.deliverRoute(json)
  }
}
