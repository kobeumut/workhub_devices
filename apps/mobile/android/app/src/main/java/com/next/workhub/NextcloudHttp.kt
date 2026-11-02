package com.next.workhub

import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Minimal authenticated OCS call for native paths (push handling, quick reply). Never follows redirects. */
object NextcloudHttp {
  class Result(val status: Int, val body: String)

  fun call(account: PushAccounts.Account, password: String, method: String, path: String, json: JSONObject? = null): Result {
    require(path.startsWith("/") && !path.startsWith("//") && !path.contains("..")) { "unsafe path" }
    val url = URL(account.serverBase + path + (if (path.contains('?')) "&" else "?") + "format=json")
    val conn = url.openConnection() as HttpURLConnection
    try {
      conn.instanceFollowRedirects = false
      conn.connectTimeout = 10_000
      conn.readTimeout = 15_000
      conn.requestMethod = method
      val basic = Base64.encodeToString("${account.loginName}:$password".toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
      conn.setRequestProperty("Authorization", "Basic $basic")
      conn.setRequestProperty("OCS-APIRequest", "true")
      conn.setRequestProperty("Accept", "application/json")
      conn.setRequestProperty("User-Agent", "WorkhubMobile/0.1 (android; native)")
      if (json != null) {
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(json.toString().toByteArray(Charsets.UTF_8)) }
      }
      val status = conn.responseCode
      val stream = if (status in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
      return Result(status, body)
    } finally {
      conn.disconnect()
    }
  }
}
